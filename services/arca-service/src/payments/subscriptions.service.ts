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

  /** Activate (or extend) a subscription after a confirmed payment. */
  async grant(userWallet: string, listingId: string): Promise<Subscription> {
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
      return this.subs.save(existing);
    }

    const sub = this.subs.create({
      userWallet,
      listingId,
      expiresAt,
      status: 'active',
    });
    this.logger.log(`granted access ${userWallet} -> ${listingId} until ${expiresAt.toISOString()}`);
    return this.subs.save(sub);
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

  /** GET /v1/subscriptions/:user_wallet — all subscriptions of a user. */
  async forUser(userWallet: string): Promise<Subscription[]> {
    return this.subs.find({
      where: { userWallet },
      order: { updatedAt: 'DESC' },
    });
  }
}
