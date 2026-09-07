import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { DepositAddress } from './deposit-address.entity';
import { ListingRef } from './listing-ref.entity';
import { HdWalletService } from './hd-wallet.service';

export class CreateDepositDto {
  @IsUUID('all')
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
  ) {}

  /** POST /v1/arca/deposit-address — generate a unique derived address for (user, listing). */
  async generate(userWallet: string, listingId: string): Promise<GeneratedDeposit> {
    if (!this.hd.enabled) {
      throw new BadRequestException(
        'Deposit generation disabled: ARCA_MASTER_PRIVATE_KEY is not configured',
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

    const deposit = this.deposits.create({
      userWallet,
      listingId,
      derivedAddress: address,
      derivationPath: path,
      expectedAmount: listing.arcaGateAmount,
      status: 'pending',
    });
    await this.deposits.save(deposit).catch((err) => {
      // UNIQUE violation => address already used; surface a clear error.
      if (err?.code === '23505') {
        throw new BadRequestException('derived address collision; retry');
      }
      throw err;
    });

    return {
      deposit_address: address,
      expected_amount: listing.arcaGateAmount,
      expires_in: DEPOSIT_TTL_SECONDS,
    };
  }

  /** Find a pending deposit by its derived address (used by the listener). */
  findByDerivedAddress(address: string): Promise<DepositAddress | null> {
    return this.deposits.findOne({ where: { derivedAddress: address, status: 'pending' } });
  }

  /** Mark a deposit received (called by the listener after confirmation). */
  async markReceived(id: string): Promise<void> {
    await this.deposits.update({ id }, { status: 'received' });
  }
}
