import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { Subscription } from './subscription.entity';

/**
 * Grants and inspects content-access subscriptions (§10.5).
 *
 * There is no per-listing duration column in §7, so the subscription period is
 * SUBSCRIPTION_DAYS (default 30) — a deliberate V1 constant, overridable via
 * env SUBSCRIPTION_DAYS. Revisit if listings grow a duration field.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly durationDays: number;
  private readonly graceHours: number;

  constructor(
    @InjectRepository(Subscription)
    private readonly subs: Repository<Subscription>,
    config: ConfigService,
  ) {
    const d = parseInt(config.get<string>('SUBSCRIPTION_DAYS') ?? '30', 10);
    this.durationDays = Number.isFinite(d) && d > 0 ? d : 30;
    // Same default as ReminderService — the two must agree or access would be
    // revoked on a different clock than the one that flips the status.
    const g = parseInt(config.get<string>('ARCA_GRACE_HOURS') ?? '48', 10);
    this.graceHours = Number.isFinite(g) && g > 0 ? g : 48;
  }

  /** Start of the grace window: subscriptions expiring after this still count. */
  graceCutoff(now = new Date()): Date {
    return new Date(now.getTime() - this.graceHours * 3600 * 1000);
  }

  /**
   * Activate (or extend) a subscription after a confirmed payment.
   *
   * IT BINDS THE AGENT, and that line is the whole reason a subscription does
   * anything. The fan-out finds who to trade for with
   * `WHERE agent_id = $1 AND status = 'active' ...`, so a subscription that
   * does not carry the agent is one the agent never trades for — the customer
   * pays, every other part works, and nothing happens in their wallet.
   *
   * It comes from the LISTING, never from the caller: which agent trades for
   * you is a property of what was bought.
   *
   * It is set on renewal too, not only on create. A renewal is the repair path
   * for a row written before this existed, and repairing it silently is better
   * than leaving a paying customer untraded-for until somebody notices.
   */
  async grant(userWallet: string, listingId: string): Promise<Subscription> {
    const agentId = await this.agentOfListing(listingId);
    // A renew arriving during the grace window must revive that row, not open a
    // second one — otherwise the user ends up with two subscriptions.
    const existing = await this.subs.findOne({
      where: { userWallet, listingId, status: In(['active', 'grace']) },
    });

    // Extension: keep the current expiry and add the period on top; otherwise
    // start from now.
    const base = existing?.expiresAt && existing.expiresAt > new Date()
      ? existing.expiresAt
      : new Date();
    const expiresAt = new Date(
      base.getTime() + this.durationDays * 24 * 3600 * 1000,
    );

    if (existing) {
      existing.expiresAt = expiresAt;
      existing.status = 'active';
      existing.lastReminderStage = null;
      existing.updatedAt = new Date();
      if (!existing.agentId && agentId) existing.agentId = agentId;
      return this.subs.save(existing);
    }

    const sub = this.subs.create({
      userWallet,
      listingId,
      agentId,
      expiresAt,
      status: 'active',
    });
    this.logger.log(
      `granted ${userWallet} -> listing ${listingId} (agent ${agentId ?? 'NONE'}) until ` +
      `${expiresAt.toISOString()}`);
    if (!agentId) {
      // NOT AN ERROR, AND NOT SILENT. A listing with no agent sells access to
      // nothing that trades, which is a listing problem rather than a payment
      // one — the payment was real and the subscription is real. But a buyer
      // who will never be traded for must not be created quietly.
      this.logger.warn(
        `listing ${listingId} names no agent, so subscription for ${userWallet} will never be ` +
        'traded for. The payment succeeded; the listing is the thing to look at');
    }
    return this.subs.save(sub);
  }

  /** The agent a listing sells. Null when the listing names none. */
  private async agentOfListing(listingId: string): Promise<string | null> {
    const rows = await this.subs.manager.query(
      'SELECT agent_id::text AS agent_id FROM marketplace_listings WHERE id = $1',
      [listingId],
    );
    return rows[0]?.agent_id ?? null;
  }

  /**
   * True while the user still holds access to the listing.
   *
   * Access outlives `expires_at` by the grace window (§10.4: 24-48h after
   * expiry before access is revoked). Cutting access exactly at expiry would
   * make the grace period meaningless — it would only delay a status label
   * while the user was already locked out.
   */
  async hasAccess(userWallet: string, listingId: string): Promise<boolean> {
    const sub = await this.subs.findOne({
      where: {
        userWallet,
        listingId,
        status: In(['active', 'grace']),
        expiresAt: MoreThanOrEqual(this.graceCutoff()),
      },
    });
    return !!sub;
  }

  /**
   * GET /v1/subscriptions/:user_wallet — all subscriptions of a user.
   *
   * IT SAYS WHETHER THE AGENT IS ACTUALLY TRADING FOR YOU, and if not, what is
   * missing. The four conditions are the same ones the fan-out applies, stated
   * rather than left to be inferred from a status column that only answers one
   * of them: a buyer whose wallet was never derived, or who paused themselves,
   * reads `active` and concludes something untrue.
   */
  async forUser(userWallet: string) {
    const rows = await this.subs.find({
      where: { userWallet },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((s) => {
      const expired = s.expiresAt <= new Date();
      const trading = s.status === 'active' && !s.tradingPaused && !expired && !!s.walletAddress;
      return { ...s, trading, next_step: this.nextStep(s, trading, expired) };
    });
  }

  /** One sentence the buyer can act on. Never "everything is fine" when it is not. */
  private nextStep(s: Subscription, trading: boolean, expired: boolean): string {
    if (!s.agentId) {
      return 'This listing names no agent, so nothing trades for this subscription. Your payment ' +
        'went through — the listing is the thing to look at.';
    }
    if (!s.walletAddress) {
      return 'Derive your trading wallet with POST /v1/subscriptions/' + s.id + '/wallet, then ' +
        'fund it with USDG to trade and ETH for gas. The agent never spends anybody else’s money, ' +
        'so until you fund it nothing happens.';
    }
    if (s.tradingPaused) {
      return 'You have paused trading. The agent decides as usual and executes nothing for you. ' +
        'PATCH /v1/subscriptions/' + s.id + ' with tradingPaused=false to resume.';
    }
    if (expired || s.status !== 'active') {
      return 'The agent has stopped trading for this wallet. Whatever it holds stays where it is: ' +
        'read it at GET /v1/subscriptions/' + s.id + '/book, and take the key with ' +
        'POST /v1/subscriptions/' + s.id + '/wallet/export whenever you like.';
    }
    if (trading) {
      return 'The agent is trading for this wallet. Your own limits size every position; the ' +
        'creator chooses only the direction. Read it at GET /v1/subscriptions/' + s.id + '/book.';
    }
    return 'This subscription is not being traded for, and the reason is not one this endpoint ' +
      'recognises. That is a bug — please report it rather than assuming it is fine.';
  }
}
