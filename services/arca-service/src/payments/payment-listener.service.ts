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
  private readonly auditIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private auditTimer: NodeJS.Timeout | null = null;
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
    // Audit runs far less often than the poll: it is a backstop for money that
    // slipped past every scan, not part of the happy path.
    const audit = parseInt(config.get<string>('ARCA_AUDIT_INTERVAL_MS') ?? '300000', 10);
    this.auditIntervalMs = Number.isFinite(audit) && audit > 0 ? audit : 300000;
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
    this.auditTimer = setInterval(() => {
      void this.auditPendingDeposits().catch((e) => this.logger.error(`audit failed: ${e}`));
    }, this.auditIntervalMs);
    this.logger.log(
      `payment listener started (poll ${this.pollIntervalMs}ms, confirmations=${this.confirmations}, audit ${this.auditIntervalMs}ms)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.auditTimer) clearInterval(this.auditTimer);
  }

  /**
   * Safety net for the failure this whole mechanism exists to prevent: money
   * sitting at a deposit address that was never credited.
   *
   * A log scan can only find what it looked at. This asks the chain directly —
   * for every pending deposit past confirmation depth, does the address hold a
   * balance? A hit means funds arrived and access was never granted, which is
   * an ERROR, not a warning: it is a user who paid and got nothing, and it must
   * never again sit in the database unnoticed.
   */
  async auditPendingDeposits(): Promise<{ checked: number; stranded: number; retired: number }> {
    if (!this.token.enabled) return { checked: 0, stranded: 0, retired: 0 };

    const head = await this.token.getBlockNumber();
    const deposits = await this.depositSvc.findAuditable();
    const ttlCutoff = new Date(Date.now() - this.depositSvc.ttlSeconds * 1000);

    let checked = 0;
    let stranded = 0;
    let retired = 0;
    for (const deposit of deposits) {
      // Too young to judge: a payment may simply not have confirmed yet.
      // A row with no recorded height (pre-0016) never held the floor anyway,
      // so it is judged on balance and age alone.
      if (
        deposit.createdAtBlock != null &&
        head - BigInt(deposit.createdAtBlock) <= this.confirmations
      ) {
        continue;
      }

      checked++;

      // BALANCE FIRST, ALWAYS. Age alone cannot tell an abandoned address from
      // one that was paid but never credited, and the two demand opposite
      // actions. Retiring an address that holds funds would release the scan
      // floor and lose that payment permanently — so the balance decides, and
      // the TTL only ever gets a say once the balance is proven zero.
      const balance = await this.token.balanceOf(deposit.derivedAddress);
      if (balance > 0n) {
        stranded++;
        this.logger.error(
          `STRANDED PAYMENT: deposit ${deposit.derivedAddress} (user ${deposit.userWallet}, ` +
            `listing ${deposit.listingId}) holds ${this.toDecimalString(balance)} $ARCA but is ` +
            `${deposit.status} — funds arrived and access was NOT granted. Issued at block ` +
            `${deposit.createdAtBlock}, head ${head}. Investigate the listener scan range.`,
        );
        continue; // status untouched: pending keeps holding the scan floor
      }

      // Empty and past its promised lifetime: retire it so it stops pinning the
      // scan floor at its block and widening every getLogs call.
      if (deposit.status === 'pending' && deposit.createdAt <= ttlCutoff) {
        await this.depositSvc.markExpiredUnpaid(deposit.id);
        retired++;
        this.logger.log(
          `deposit ${deposit.derivedAddress} retired as expired_unpaid ` +
            `(issued ${deposit.createdAt.toISOString()}, never funded) — scan floor released`,
        );
      }
    }
    if (stranded === 0 && checked > 0) {
      this.logger.log(
        `deposit audit: ${checked} deposit(s) checked, none stranded, ${retired} retired`,
      );
    }
    return { checked, stranded, retired };
  }

  /** One poll cycle — returns number of payments processed. */
  async pollOnce(): Promise<number> {
    if (this.running) return 0; // no overlap within this process
    this.running = true;
    try {
      const head = await this.token.getBlockNumber();
      const from = await this.resolveScanStart(head);

      // Nothing confirmed yet above the scan start.
      if (head < this.confirmations) return 0;
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

  /**
   * First block the next scan must cover.
   *
   * The checkpoint alone is not safe. It records where scanning got to, but a
   * deposit address issued while the listener was behind — or before it ever
   * ran — can sit below that point, and its payment would never be scanned:
   * funds arrive, access is never granted, nothing warns (§10.6).
   *
   * So the checkpoint is only ever an upper bound. The floor is the oldest
   * still-pending deposit: while any address is outstanding, scanning starts no
   * later than the block it was issued at. Once every deposit is resolved the
   * checkpoint takes over again and the window collapses back to one block.
   */
  private async resolveScanStart(head: bigint): Promise<bigint> {
    const row = await this.state.findOne({
      where: { service: this.stateService, key: 'last_block' },
    });
    // Resume AFTER the last scanned block — rescanning it every poll costs a
    // getLogs round trip and yields only rows the tx_hash guard discards.
    const checkpoint = row?.value != null ? BigInt(row.value) + 1n : null;
    const oldestPending = await this.depositSvc.oldestPendingBlock();

    if (checkpoint == null) {
      // First run (or the checkpoint was lost). Anything outstanding decides
      // where to start; only with nothing pending is head safe, because then
      // there is no address a payment could already have landed on.
      return oldestPending ?? head;
    }
    if (oldestPending != null && oldestPending < checkpoint) {
      return oldestPending;
    }
    return checkpoint;
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
