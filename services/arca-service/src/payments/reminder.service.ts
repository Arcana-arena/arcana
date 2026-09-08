import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, In, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { Subscription } from './subscription.entity';
import { UserPushToken } from './user-push-token.entity';
import { ConfigService } from '@nestjs/config';

/**
 * In-app push delivery (FCM/Web Push). FCM credentials are NOT configured yet —
 * this service logs "would send push to X" as a clearly-marked stub so the
 * reminder flow can be built and verified end-to-end. Wire FCM (or Web Push)
 * here once credentials exist — nothing else in the reminder pipeline changes.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  async send(userWallet: string, title: string, body: string): Promise<void> {
    // TODO(fcm): real delivery once Firebase/WebPush credentials exist.
    // Until then the stub logs the intended push so flows are testable.
    this.logger.log(`[push-stub] would send push to ${userWallet}: "${title} — ${body}"`);
  }
}

/**
 * §10.4 Reminder Service: daily scan of subscriptions expiring within H-3/H-1/H-0
 * days, sends an in-app push per stage (idempotent via last_reminder_stage),
 * and walks the subscription lifecycle past expiry.
 *
 * Stages are only sent once per subscription: H-3 -> H-1 -> H-0 (last day).
 * Every stage fires BEFORE expires_at — a reminder that lands after the fact
 * is not a reminder, it is a notice, and the point is to let the user renew
 * while the subscription is still alive.
 *
 * Lifecycle (§10.4/§10.5): active -> grace at expires_at, grace -> expired at
 * expires_at + GRACE_HOURS. Access follows the same clock and is checked in
 * SubscriptionsService.hasAccess, so the grace window really does keep the
 * user in rather than merely relabelling a locked-out row.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private readonly graceHours: number;

  constructor(
    @InjectRepository(Subscription)
    private readonly subs: Repository<Subscription>,
    @InjectRepository(UserPushToken)
    private readonly pushTokens: Repository<UserPushToken>,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    const g = parseInt(config.get<string>('ARCA_GRACE_HOURS') ?? '48', 10);
    this.graceHours = Number.isFinite(g) && g > 0 ? g : 48;
  }

  /** Run one reminder cycle. Returns counts per action for logging. */
  async run(): Promise<{ reminded: number; grace: number; expired: number }> {
    const now = new Date();
    const reminded = await this.sendDueReminders(now);
    const { grace, expired } = await this.advanceLifecycle(now);
    return { reminded, grace, expired };
  }

  private async sendDueReminders(now: Date): Promise<number> {
    // Still-active subscriptions expiring within 3 days. Already-expired rows
    // are excluded: they belong to the lifecycle pass below, and pushing
    // "renew to keep it" at someone whose access already lapsed is misleading.
    const horizon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const due = await this.subs.find({
      where: {
        status: 'active',
        expiresAt: And(MoreThan(now), LessThanOrEqual(horizon)),
      },
    });

    let sent = 0;
    for (const sub of due) {
      // Hours, not ceil(days): with days, an expiry 2 hours out still rounds to
      // 1 and never reaches the last-day stage, so h0 could only ever fire
      // after expiry.
      const hoursLeft = (sub.expiresAt.getTime() - now.getTime()) / (3600 * 1000);
      const stage = hoursLeft <= 24 ? 'h0' : hoursLeft <= 48 ? 'h1' : 'h3';
      if (sub.lastReminderStage === stage) continue; // already reminded at this stage

      await this.push.send(sub.userWallet, 'Subscription expiring', `Access ends ${sub.expiresAt.toISOString()} — renew to keep it.`);
      sub.lastReminderStage = stage;
      sub.updatedAt = new Date();
      await this.subs.save(sub);
      sent++;
      this.logger.log(`reminder ${stage} sent for ${sub.userWallet} (listing ${sub.listingId})`);
    }
    return sent;
  }

  /**
   * Walk subscriptions through the two transitions past expiry.
   *
   * Order matters: expire first, then grace. Doing it the other way would move
   * a long-overdue row into 'grace' and only expire it on the next run, handing
   * back access that should already be gone.
   */
  private async advanceLifecycle(now: Date): Promise<{ grace: number; expired: number }> {
    const graceCutoff = new Date(now.getTime() - this.graceHours * 3600 * 1000);

    // Past expires_at + grace => expired, entitlement revoked. Includes rows
    // still marked 'active' in case a run was missed and they never saw grace.
    const overdue = await this.subs.find({
      where: { status: In(['active', 'grace']), expiresAt: LessThanOrEqual(graceCutoff) },
    });
    for (const sub of overdue) {
      sub.status = 'expired';
      sub.updatedAt = new Date();
      await this.subs.save(sub);
      this.logger.log(
        `subscription ${sub.id} expired after grace period (was due ${sub.expiresAt.toISOString()})`,
      );
    }

    // Past expires_at but inside the grace window => grace, access retained.
    const lapsed = await this.subs.find({
      where: {
        status: 'active',
        expiresAt: And(MoreThan(graceCutoff), LessThanOrEqual(now)),
      },
    });
    for (const sub of lapsed) {
      sub.status = 'grace';
      sub.updatedAt = new Date();
      await this.subs.save(sub);
      this.logger.log(
        `subscription ${sub.id} entered grace period (due ${sub.expiresAt.toISOString()}, ` +
          `access kept for ${this.graceHours}h)`,
      );
    }

    return { grace: lapsed.length, expired: overdue.length };
  }
}
