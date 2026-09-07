import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
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
 * and flips expired subscriptions after the grace period.
 *
 * Stages are only sent once per subscription: H-3 -> H-1 -> H-0 (last day).
 * Grace: after expires_at + GRACE_HOURS the subscription becomes 'expired'.
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
  async run(): Promise<{ reminded: number; expired: number }> {
    const now = new Date();
    const reminded = await this.sendDueReminders(now);
    const expired = await this.expireOverdue(now);
    return { reminded, expired };
  }

  private async sendDueReminders(now: Date): Promise<number> {
    // Active subscriptions only; scan expiring within 3 days (H-0 included).
    const horizon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const due = await this.subs.find({
      where: { status: 'active', expiresAt: LessThanOrEqual(horizon) },
    });

    let sent = 0;
    for (const sub of due) {
      const daysLeft = Math.ceil((sub.expiresAt.getTime() - now.getTime()) / (24 * 3600 * 1000));
      const stage = daysLeft <= 0 ? 'h0' : daysLeft <= 1 ? 'h1' : 'h3';
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

  private async expireOverdue(now: Date): Promise<number> {
    // Past expires_at + grace period => expired, entitlement revoked.
    const cutoff = new Date(now.getTime() - this.graceHours * 3600 * 1000);
    const overdue = await this.subs.find({
      where: { status: 'active', expiresAt: LessThanOrEqual(cutoff) },
    });

    for (const sub of overdue) {
      sub.status = 'expired';
      sub.updatedAt = new Date();
      await this.subs.save(sub);
      this.logger.log(`subscription ${sub.id} expired after grace period (was due ${sub.expiresAt.toISOString()})`);
    }
    return overdue.length;
  }
}
