import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
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

  constructor(
    @InjectRepository(Subscription)
    private readonly subs: Repository<Subscription>,
    config: ConfigService,
  ) {
    const d = parseInt(config.get<string>('SUBSCRIPTION_DAYS') ?? '30', 10);
    this.durationDays = Number.isFinite(d) && d > 0 ? d : 30;
  }

  /** Activate (or extend) a subscription after a confirmed payment. */
  async grant(userWallet: string, listingId: string): Promise<Subscription> {
    const existing = await this.subs.findOne({
      where: { userWallet, listingId, status: 'active' },
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

  /** True when the user has an active (non-expired) sub for the listing. */
  async hasAccess(userWallet: string, listingId: string): Promise<boolean> {
    const sub = await this.subs.findOne({
      where: {
        userWallet,
        listingId,
        status: 'active',
        expiresAt: MoreThanOrEqual(new Date()),
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
