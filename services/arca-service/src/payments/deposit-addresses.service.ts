import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsString, IsUUID, Matches } from 'class-validator';
import { Repository } from 'typeorm';
import { DepositAddress } from './deposit-address.entity';
import { ListingRef } from './listing-ref.entity';
import { HdWalletService } from './hd-wallet.service';
import { ArcaTokenService } from './arca-token.service';

export class CreateDepositDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'userWallet must be an EVM address (0x + 40 hex)' })
  userWallet!: string;

  @IsUUID('all')
  listingId!: string;
}

export interface GeneratedDeposit {
  deposit_address: string;
  expected_amount: string;
  expires_in: number; // seconds before the pending address is considered expired
}

const DEPOSIT_TTL_SECONDS = 24 * 3600; // pending addresses expire after 24h

@Injectable()
export class DepositAddressesService {
  constructor(
    @InjectRepository(DepositAddress)
    private readonly deposits: Repository<DepositAddress>,
    @InjectRepository(ListingRef)
    private readonly listings: Repository<ListingRef>,
    private readonly hd: HdWalletService,
    private readonly token: ArcaTokenService,
  ) {}

  /** POST /v1/arca/deposit-address — generate a unique derived address for (user, listing). */
  async generate(userWallet: string, listingId: string): Promise<GeneratedDeposit> {
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
      expires_in: DEPOSIT_TTL_SECONDS,
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

  /** Mark a deposit received (called by the listener after confirmation). */
  async markReceived(id: string): Promise<void> {
    await this.deposits.update({ id }, { status: 'received' });
  }
}
