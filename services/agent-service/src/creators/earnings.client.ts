import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_CONFIG, authUnavailable, type AuthConfig } from '@arcana/auth';

/**
 * A creator's earnings, asked of the service that verified the payments.
 *
 * NOT RECOMPUTED HERE. `payment_claims` is written by the chain verification in
 * arca-service, and a second sum over the same table in a second service is a
 * second definition of "what this creator has been paid" — the kind that agrees
 * until one of them learns about a second settlement token and the other does
 * not. The same reasoning the marketplace's quote proxy is built on.
 *
 * THE OWNERSHIP CHECK IS HERE, not there. arca-service does not hold the
 * session, so it must not be the thing deciding who may read a creator's
 * revenue; this service proves the caller owns the creator profile and then
 * asks on the machine tier.
 */
@Injectable()
export class CreatorEarningsService {
  private readonly logger = new Logger(CreatorEarningsService.name);
  private readonly arcaUrl: string;

  constructor(
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
    config: ConfigService,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://127.0.0.1:3004';
  }

  async forCreator(creatorId: string) {
    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so this service cannot reach the payment record. No earnings ' +
        'figure can be stated — and an unread total must not be shown as zero.',
      );
    }
    const res = await fetch(
      `${this.arcaUrl}/internal/v1/creators/${encodeURIComponent(creatorId)}/earnings`,
      { headers: { 'X-Internal-Key': this.authCfg.internalKey } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`earnings read failed for creator ${creatorId}: ${res.status} ${text.slice(0, 200)}`);
      // A FAILURE IS RETURNED, NOT THROWN. The dashboard has five other panels
      // and none of them should disappear because the payment service blinked —
      // but the earnings panel must say it could not be read rather than
      // rendering an empty table that means "you have earned nothing".
      return {
        available: false,
        reason: `the payment record answered ${res.status}`,
        totals: null,
        by_week: [],
        recent: [],
        subscribers: null,
      };
    }
    return { available: true, reason: null, ...((await res.json()) as Record<string, unknown>) };
  }
}
