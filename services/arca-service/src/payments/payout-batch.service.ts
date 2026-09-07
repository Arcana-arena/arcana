import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  createWalletClient,
  http,
  type Address,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentEvent } from './payment-event.entity';
import { CreatorPayout } from './creator-payout.entity';
import { DepositAddress } from './deposit-address.entity';
import { ListingRef } from './listing-ref.entity';
import { ArcaTokenService } from './arca-token.service';

/**
 * Off-chain split & payout batch (§10.3):
 *   1. take payment_events with payout_status='pending'
 *   2. split amount by the listing's revenue_share_creator (default 80/20)
 *   3. accumulate per creator and send ONE $ARCA transfer per creator per
 *      period from the operational treasury wallet
 *   4. record creator_payouts rows with the tx hash
 *
 * Idempotent per payment_event: rows are marked paid in the same step, and the
 * batch only ever looks at payout_status='pending'. Safe to re-run.
 *
 * Gas check: transferring $ARCA costs ETH. If the treasury has no ETH the batch
 * skips with a loud warning — never silently fails.
 */
@Injectable()
export class PayoutBatchService {
  private readonly logger = new Logger(PayoutBatchService.name);
  private readonly treasuryWallet: WalletClient | null;
  private readonly treasuryAddress: Address | null;
  private readonly rpc: string | null;

  constructor(
    @InjectRepository(PaymentEvent)
    private readonly payments: Repository<PaymentEvent>,
    @InjectRepository(CreatorPayout)
    private readonly payouts: Repository<CreatorPayout>,
    @InjectRepository(DepositAddress)
    private readonly deposits: Repository<DepositAddress>,
    @InjectRepository(ListingRef)
    private readonly listings: Repository<ListingRef>,
    private readonly token: ArcaTokenService,
    config: ConfigService,
  ) {
    this.rpc = config.get<string>('ARCA_RPC_URL') ?? null;
    const treasuryKey = config.get<string>('ARCA_TREASURY_PRIVATE_KEY');
    if (treasuryKey && this.rpc && this.token.tokenAddress) {
      const account = privateKeyToAccount(
        (treasuryKey.startsWith('0x') ? treasuryKey : `0x${treasuryKey}`) as Address,
      );
      this.treasuryAddress = account.address;
      this.treasuryWallet = createWalletClient({
        account,
        transport: http(this.rpc),
      });
    } else {
      this.logger.warn(
        'Payout batch disabled: set ARCA_TREASURY_PRIVATE_KEY, ARCA_RPC_URL and ARCA_TOKEN_ADDRESS',
      );
      this.treasuryWallet = null;
      this.treasuryAddress = null;
    }
  }

  get enabled(): boolean {
    return this.treasuryWallet != null && this.token.tokenAddress != null;
  }

  /** Run one payout cycle. Returns a summary. */
  async run(): Promise<{ processed: number; paid_out: number; skipped: string[] }> {
    const skipped: string[] = [];
    if (!this.enabled) {
      skipped.push('payout disabled: treasury/RPC/token not configured');
      return { processed: 0, paid_out: 0, skipped };
    }

    const pending = await this.payments.find({
      where: { payoutStatus: 'pending' },
    });
    if (pending.length === 0) {
      return { processed: 0, paid_out: 0, skipped };
    }

    // Resolve each payment: deposit -> listing (revenue share) -> creator.
    const byCreator = new Map<string, { amount: bigint; events: PaymentEvent[] }>();
    for (const ev of pending) {
      const deposit = await this.deposits.findOne({
        where: { id: ev.depositAddressId },
      });
      if (!deposit) {
        skipped.push(`payment ${ev.txHash}: deposit not found`);
        continue;
      }
      const listing = await this.listings.findOne({
        where: { id: deposit.listingId },
      });
      if (!listing) {
        skipped.push(`payment ${ev.txHash}: listing ${deposit.listingId} not found`);
        continue;
      }
      // listing -> agent -> creator
      const creatorId = await this.creatorForListing(listing.id);
      if (!creatorId) {
        skipped.push(`payment ${ev.txHash}: no creator for listing ${listing.id}`);
        continue;
      }

      const creatorShareRatio = parseFloat(listing.revenueShareCreator || '0.8');
      const amountWei = this.toWei(ev.amount);
      const creatorShareWei = (amountWei * BigInt(Math.round(creatorShareRatio * 100))) / 100n;
      const platformShareWei = amountWei - creatorShareWei;

      // Persist split on the event (creator/platform shares) + mark paid.
      ev.creatorShare = this.fromWei(creatorShareWei);
      ev.platformShare = this.fromWei(platformShareWei);
      ev.payoutStatus = 'paid';
      await this.payments.save(ev);

      const acc = byCreator.get(creatorId) ?? { amount: 0n, events: [] };
      acc.amount += creatorShareWei;
      acc.events.push(ev);
      byCreator.set(creatorId, acc);
    }

    // Send one transfer per creator.
    let paidOut = 0;
    for (const [creatorId, { amount }] of byCreator) {
      if (amount <= 0n) continue;
      try {
        const txHash = await this.transferToCreator(creatorId, amount);
        const payout = this.payouts.create({
          creatorId,
          periodStart: new Date(),
          periodEnd: new Date(),
          totalAmount: this.fromWei(amount),
          txHash,
          status: 'paid',
        });
        await this.payouts.save(payout);
        paidOut++;
      } catch (e) {
        // Roll back the 'paid' flags so a later run retries these events.
        for (const ev of byCreator.get(creatorId)?.events ?? []) {
          ev.payoutStatus = 'pending';
          await this.payments.save(ev);
        }
        skipped.push(`creator ${creatorId}: payout failed: ${e}`);
      }
    }

    return { processed: pending.length, paid_out: paidOut, skipped };
  }

  private async creatorForListing(listingId: string): Promise<string | null> {
    // marketplace_listings -> agents -> creators
    const row = await this.payments.manager.query(
      `SELECT c.id FROM agents a
       JOIN marketplace_listings l ON l.agent_id = a.id
       JOIN creators c ON c.id = a.creator_id
       WHERE l.id = $1 LIMIT 1`,
      [listingId],
    );
    return row?.[0]?.id ?? null;
  }

  private async transferToCreator(creatorId: string, amountWei: bigint): Promise<string> {
    if (!this.treasuryWallet || !this.treasuryAddress || !this.token.tokenAddress) {
      throw new Error('treasury not configured');
    }
    const from = this.treasuryWallet.account.address;

    const ethBalance = await this.treasuryWallet.getBalance({ address: from });
    const gas = await this.treasuryWallet.estimateGas({
      account: this.treasuryAddress,
      to: this.token.tokenAddress,
      data: this.transferData(creatorId, amountWei),
    });
    const gasPrice = await this.treasuryWallet.getGasPrice();
    const gasCost = gas * gasPrice;

    if (ethBalance < gasCost) {
      throw new Error(
        `treasury ${from} has insufficient ETH for gas: have ${ethBalance}, need ~${gasCost}`,
      );
    }

    const hash = await this.treasuryWallet.sendTransaction({
      to: this.token.tokenAddress,
      data: this.transferData(creatorId, amountWei),
    });
    this.logger.log(
      `payout sent: ${this.fromWei(amountWei)} $ARCA to creator ${creatorId} (tx ${hash})`,
    );
    return hash;
  }

  private transferData(to: string, amountWei: bigint): `0x${string}` {
    // erc20 transfer(address,uint256) selector
    return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amountWei.toString(16).padStart(64, '0')}` as `0x${string}`;
  }

  private toWei(amount: string): bigint {
    const decimals = 18;
    const [int, frac = ''] = amount.split('.');
    const padded = (int + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
    return BigInt(padded || '0');
  }

  private fromWei(wei: bigint): string {
    const decimals = 18;
    const s = wei.toString().padStart(decimals + 1, '0');
    const int = s.slice(0, -decimals);
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return frac ? `${int}.${frac}` : int;
  }
}
