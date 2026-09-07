import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DepositAddress } from './deposit-address.entity';
import { PaymentEvent } from './payment-event.entity';
import { ServiceState } from './service-state.entity';
import { ArcaTokenService } from './arca-token.service';
import { DepositAddressesService } from './deposit-addresses.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Payment listener / indexer (§10.2): watches Transfer events of the $ARCA
 * token, matches transfers into pending deposit addresses, waits for
 * confirmation, then records payment_events + grants access.
 *
 * CONFIRMATION_THRESHOLD: default 12 blocks. Robinhood Chain block time is not
 * pinned in the codebase; 12 is a conservative anti-reorg choice. Tune via env
 * ARCA_CONFIRMATIONS once the chain's finality behaviour is known.
 *
 * CHECKPOINT: last processed block is persisted in service_state so restarts
 * backfill from there (never from genesis).
 */
@Injectable()
export class PaymentListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentListenerService.name);
  private readonly confirmations: bigint;
  private readonly pollIntervalMs: number;
  private readonly stateService = 'payment-listener';
  private readonly decimals: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectRepository(DepositAddress)
    private readonly deposits: Repository<DepositAddress>,
    @InjectRepository(PaymentEvent)
    private readonly payments: Repository<PaymentEvent>,
    @InjectRepository(ServiceState)
    private readonly state: Repository<ServiceState>,
    private readonly token: ArcaTokenService,
    private readonly depositSvc: DepositAddressesService,
    private readonly subs: SubscriptionsService,
    config: ConfigService,
  ) {
    const conf = parseInt(config.get<string>('ARCA_CONFIRMATIONS') ?? '12', 10);
    this.confirmations = BigInt(Number.isFinite(conf) && conf > 0 ? conf : 12);
    const ms = parseInt(config.get<string>('ARCA_POLL_INTERVAL_MS') ?? '15000', 10);
    this.pollIntervalMs = Number.isFinite(ms) && ms > 0 ? ms : 15000;
    // ASSUMPTION: standard ERC-20 decimals = 18 (not stated in architecture.md).
    // Override via ARCA_TOKEN_DECIMALS once the real $ARCA token is known.
    const dec = parseInt(config.get<string>('ARCA_TOKEN_DECIMALS') ?? '18', 10);
    this.decimals = Number.isFinite(dec) && dec >= 0 ? dec : 18;
  }

  onModuleInit() {
    if (!this.token.enabled) {
      this.logger.warn(
        'Payment listener disabled: set ARCA_RPC_URL and ARCA_TOKEN_ADDRESS (token not launched yet).',
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce().catch((e) => this.logger.error(`poll failed: ${e}`));
    }, this.pollIntervalMs);
    this.logger.log(
      `payment listener started (poll ${this.pollIntervalMs}ms, confirmations=${this.confirmations})`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll cycle — returns number of payments processed. */
  async pollOnce(): Promise<number> {
    if (this.running) return 0; // no overlap within this process
    this.running = true;
    try {
      const from = await this.loadCheckpoint();
      const head = await this.token.getBlockNumber();

      // Nothing new (head == checkpoint) or nothing confirmed yet.
      if (head - from < this.confirmations) return 0;
      const confirmedTo = head - this.confirmations;
      if (from > confirmedTo) return 0;

      this.logger.log(`scanning blocks ${from}..${confirmedTo}`);
      const logs = await this.token.getTransferLogs(from, confirmedTo);
      if (logs.length === 0) {
        await this.saveCheckpoint(confirmedTo);
        return 0;
      }

      let processed = 0;
      for (const log of logs) {
        const ok = await this.processTransfer(log.txHash, log.to, log.value);
        if (ok) processed++;
      }
      await this.saveCheckpoint(confirmedTo);
      return processed;
    } finally {
      this.running = false;
    }
  }

  /** Match one confirmed Transfer into a pending deposit; returns true if handled. */
  private async processTransfer(txHash: string, to: string, value: bigint): Promise<boolean> {
    const existing = await this.payments.findOne({ where: { txHash } });
    if (existing) return false; // idempotent — already recorded

    const deposit = await this.deposits.findOne({
      where: { derivedAddress: to, status: 'pending' },
    });
    if (!deposit) return false; // not one of ours / already received

    const amount = this.toDecimalString(value);
    if (Number(amount) < Number(deposit.expectedAmount)) {
      // §10.6: underpayment => do not grant access. Leave deposit pending and
      // record nothing; a human/ops resolves it.
      this.logger.warn(
        `underpayment ${txHash}: got ${amount}, expected ${deposit.expectedAmount} (access not granted)`,
      );
      return false;
    }

    // Record + grant atomically enough for V1 (each step idempotent by tx_hash).
    await this.payments.insert({
      txHash,
      depositAddressId: deposit.id,
      amount,
      creatorShare: null, // filled by the payout batch (Tahap 4)
      platformShare: null,
      payoutStatus: 'pending',
    });
    await this.depositSvc.markReceived(deposit.id);
    await this.subs.grant(deposit.userWallet, deposit.listingId);
    this.logger.log(
      `payment recorded ${txHash}: ${amount} $ARCA -> deposit ${deposit.derivedAddress} (user ${deposit.userWallet})`,
    );
    return true;
  }

  private async loadCheckpoint(): Promise<bigint> {
    const row = await this.state.findOne({
      where: { service: this.stateService, key: 'last_block' },
    });
    if (row?.value) return BigInt(row.value);
    // No checkpoint: start from the current head (no genesis rescan).
    const head = await this.token.getBlockNumber();
    return head > this.confirmations ? head - this.confirmations : 0n;
  }

  private async saveCheckpoint(block: bigint): Promise<void> {
    await this.state.upsert(
      {
        service: this.stateService,
        key: 'last_block',
        value: block.toString(),
        updatedAt: new Date(),
      },
      ['service', 'key'],
    );
  }

  private toDecimalString(value: bigint): string {
    const s = value.toString().padStart(this.decimals + 1, '0');
    const intPart = s.slice(0, -this.decimals);
    const frac = s.slice(-this.decimals).replace(/0+$/, '');
    return frac ? `${intPart}.${frac}` : intPart;
  }
}
