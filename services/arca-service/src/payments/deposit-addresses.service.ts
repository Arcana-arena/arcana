import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsString, IsUUID, Matches } from 'class-validator';
import { MoreThan, Repository } from 'typeorm';
import { DepositAddress } from './deposit-address.entity';
import { ListingRef } from './listing-ref.entity';
import { HdWalletService } from './hd-wallet.service';
import { ArcaTokenService } from './arca-token.service';

/**
 * The wallet is NOT a field here: it comes from the caller's verified session.
 * Accepting it from the body let anyone mint a deposit address in another
 * user's name. With `forbidNonWhitelisted` on the global pipe, sending
 * `userWallet` is now a 400 rather than a silently ignored key.
 */
export class CreateDepositDto {
  @IsUUID('all')
  listingId!: string;
}

export interface GeneratedDeposit {
  deposit_address: string;
  expected_amount: string;
  expires_in: number; // seconds before the pending address is considered expired
}

@Injectable()
export class DepositAddressesService {
  /**
   * How long a pending deposit address stays valid. One value, because two
   * would drift: it is both the `expires_in` promised to the user and the age
   * at which the audit may retire an unpaid address. Retiring one earlier than
   * promised would strand a payment the user made in good time.
   */
  readonly ttlSeconds: number;

  constructor(
    @InjectRepository(DepositAddress)
    private readonly deposits: Repository<DepositAddress>,
    @InjectRepository(ListingRef)
    private readonly listings: Repository<ListingRef>,
    private readonly hd: HdWalletService,
    private readonly token: ArcaTokenService,
    config: ConfigService,
  ) {
    const hours = parseInt(config.get<string>('ARCA_DEPOSIT_TTL_HOURS') ?? '24', 10);
    this.ttlSeconds = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600;
  }

  /**
   * The interlock. Retirement that a single environment variable can undo is
   * not retirement — see the note in `generate()`.
   *
   * `ARCA_DEPOSIT_ADDRESSES_REVIVE=i-know-this-is-retired` exists only so the
   * verification suite can still exercise the code path behind it. It is not an
   * operational switch, it is deliberately awkward to type, and setting it in
   * production would re-enable a payment model this project abandoned.
   */
  private assertNotRetired(): void {
    if (process.env.ARCA_DEPOSIT_ADDRESSES_REVIVE === 'i-know-this-is-retired') return;
    throw new BadRequestException(
      'Deposit addresses are retired. The marketplace is P2P with no fee: pay the ' +
        "creator's wallet directly and submit the transaction hash for verification. " +
        'See docs/on-chain-direction.md §g. This refusal is by decision and is not ' +
        'lifted by setting ARCA_MASTER_PRIVATE_KEY or ARCA_RPC_URL.',
    );
  }

  /** POST /v1/arca/deposit-address — generate a unique derived address for (user, listing). */
  async generate(userWallet: string, listingId: string): Promise<GeneratedDeposit> {
    // ---------------------------------------------------------------------
    // RETIRED BY DECISION, 2026-09-10. This refuses on purpose, not on config.
    //
    // The marketplace is now P2P with no fee: the buyer transfers straight to
    // the creator's wallet and submits the transaction hash, which ARCANA
    // verifies against the chain. No deposit address, no treasury transit, no
    // off-chain split (docs/on-chain-direction.md §g).
    //
    // WHY THIS IS A HARD REFUSAL AND NOT A DELETION. The path below still
    // works. It refused until today only because ARCA_MASTER_PRIVATE_KEY and
    // ARCA_RPC_URL are empty — and docs/arca-go-live.md is a written procedure
    // instructing somebody to fill exactly those in. Following it would have
    // silently activated a payment model this project has abandoned, and
    // started routing real user money through an ARCANA-controlled address.
    //
    // A retired path that is one environment variable away from waking up is
    // not retired. Deleting the code is the phase-11 job, once tx-hash
    // verification exists to replace it; until then this is the interlock, and
    // it cannot be undone by configuration.
    //
    // The behaviour a caller sees is unchanged — this endpoint already refused
    // every request. Only the reason is now true.
    this.assertNotRetired();

    if (!this.hd.enabled) {
      throw new BadRequestException(
        'Deposit generation disabled: ARCA_MASTER_PRIVATE_KEY is not configured',
      );
    }
    // Never hand out an address the listener cannot watch: without a chain
    // connection we cannot record created_at_block, and a transfer to that
    // address would be invisible to every future scan (the payment-loss hole
    // of §10.6). Refusing here is the loud failure; issuing is the silent one.
    if (!this.token.enabled) {
      throw new BadRequestException(
        'Deposit generation disabled: ARCA_RPC_URL / ARCA_TOKEN_ADDRESS not configured, ' +
          'so an incoming payment could not be detected',
      );
    }

    const listing = await this.listings.findOne({ where: { id: listingId, active: true } });
    if (!listing) {
      throw new NotFoundException(`Listing ${listingId} not found or inactive`);
    }
    if (!listing.arcaGateAmount) {
      throw new BadRequestException(`Listing ${listingId} has no arca_gate_amount set`);
    }

    // Next unused derivation index = max recorded + 1. UNIQUE(derived_address)
    // guards against any reuse race.
    const max = await this.deposits
      .createQueryBuilder('d')
      .select('MAX(d.derivationPath)', 'maxPath')
      .getRawOne<{ maxPath: string | null }>();

    let nextIndex = 0;
    if (max?.maxPath) {
      const match = max.maxPath.match(/\/(\d+)$/);
      nextIndex = match ? parseInt(match[1], 10) + 1 : 0;
    }

    const { address, path } = this.hd.derive(nextIndex);

    // Height BEFORE the address reaches the user, so the recorded floor is
    // never above the block of a transfer the user makes against it.
    const createdAtBlock = (await this.token.getBlockNumber()).toString();

    // Store lowercase so the listener's log matching (Transfer `to` is always
    // lowercase from the RPC) hits reliably.
    const deposit = this.deposits.create({
      userWallet,
      listingId,
      derivedAddress: address.toLowerCase(),
      derivationPath: path,
      expectedAmount: listing.arcaGateAmount,
      status: 'pending',
      createdAtBlock,
    });
    await this.deposits.save(deposit).catch((err) => {
      // UNIQUE violation => address already used; surface a clear error.
      if (err?.code === '23505') {
        throw new BadRequestException('derived address collision; retry');
      }
      throw err;
    });

    return {
      deposit_address: address.toLowerCase(),
      expected_amount: listing.arcaGateAmount,
      expires_in: this.ttlSeconds,
    };
  }

  /** Find a pending deposit by its derived address (used by the listener). */
  findByDerivedAddress(address: string): Promise<DepositAddress | null> {
    return this.deposits.findOne({ where: { derivedAddress: address, status: 'pending' } });
  }

  /**
   * Lowest chain height among still-pending deposits, or null when there is
   * nothing outstanding. The listener clamps its scan start to this so an
   * address issued while the listener was behind can never be scanned past.
   *
   * Only 'pending' counts. Addresses retired as 'expired_unpaid' by the audit
   * are proven empty and no longer worth watching — without that exit the
   * floor would stay pinned at the oldest never-paid address forever and the
   * scan range would widen indefinitely.
   *
   * Rows predating migration 0016 have a NULL height and are ignored — they
   * would otherwise force a rescan from genesis on every poll.
   */
  async oldestPendingBlock(): Promise<bigint | null> {
    const row = await this.deposits
      .createQueryBuilder('d')
      .select('MIN(d.createdAtBlock)', 'minBlock')
      .where('d.status = :status', { status: 'pending' })
      .andWhere('d.createdAtBlock IS NOT NULL')
      .getRawOne<{ minBlock: string | null }>();
    return row?.minBlock != null ? BigInt(row.minBlock) : null;
  }

  /** All still-pending deposits (used by the audit pass). */
  findPending(): Promise<DepositAddress[]> {
    return this.deposits.find({ where: { status: 'pending' } });
  }

  /**
   * Rows the audit must look at: everything pending, plus recently retired
   * addresses.
   *
   * Retiring an address releases the scan floor, so a payment sent to it after
   * that point would never be scanned — the exact silent loss this design
   * refuses to allow. Keeping retired rows in the audit for a bounded window
   * means such a late payment still raises an alarm instead of vanishing. The
   * window is bounded (2x TTL) so the audit set cannot grow without limit.
   */
  findAuditable(): Promise<DepositAddress[]> {
    const window = new Date(Date.now() - 2 * this.ttlSeconds * 1000);
    return this.deposits.find({
      where: [
        { status: 'pending' },
        { status: 'expired_unpaid', createdAt: MoreThan(window) },
      ],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Retire an unpaid address so it stops holding the listener's scan floor.
   * Callers MUST confirm the on-chain balance is zero first — see the audit
   * pass. Retiring an address that holds funds would drop it out of the scan
   * range and lose the payment for good.
   */
  async markExpiredUnpaid(id: string): Promise<void> {
    await this.deposits.update({ id }, { status: 'expired_unpaid' });
  }

  /** Mark a deposit received (called by the listener after confirmation). */
  async markReceived(id: string): Promise<void> {
    await this.deposits.update({ id }, { status: 'received' });
  }
}
