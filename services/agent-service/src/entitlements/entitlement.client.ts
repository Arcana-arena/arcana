import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Whether a gate is currently enforcing — described rather than decided.
 *
 * `active`   the token and a threshold are configured; a real wallet gets a
 *            real balance read against `required`.
 * `inactive` the check passes without reading anything (token unlaunched, or
 *            no threshold set for this action).
 * `unknown`  arca-service could not be reached, so the status was not read.
 *            Deliberately NOT collapsed into `inactive`.
 */
export interface GateStatus {
  action: string;
  status: 'active' | 'inactive' | 'unknown';
  /** Threshold in $ARCA, or null when there is none or it was not read. */
  required: string | null;
  /** The entitlement layer's own reason string, or null when unread. */
  reason: string | null;
}

/**
 * Asks arca-service whether an action is entitled (architecture.md §2.7).
 *
 * The rule this client enforces at the call site is the one learned from the
 * marketplace's `hasAccess`: when the authority is unreachable, do NOT decide
 * on its behalf. Failing open would grant an entitlement nobody checked;
 * failing closed would tell a paying user they lack a right they may well hold.
 * Both are lies with a clean-looking response. A 502 says what actually
 * happened.
 */
@Injectable()
export class EntitlementClient {
  private readonly logger = new Logger(EntitlementClient.name);
  private readonly arcaUrl: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://localhost:3004';
  }

  /**
   * Throws 403 when the entitlement is denied, 502 when the answer cannot be
   * obtained. Returns the decision when allowed, so a caller can log WHY it was
   * allowed — including "nothing was actually checked".
   */
  async require(action: string, wallet: string | null, subject: string) {
    const url =
      `${this.arcaUrl}/v1/arca/entitlements/check` +
      `?action=${encodeURIComponent(action)}` +
      (wallet ? `&user_id=${encodeURIComponent(wallet)}` : '');

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw this.upstreamError(action, `arca-service unreachable: ${e}`, null);
    }
    if (!res.ok) {
      throw this.upstreamError(action, await res.text(), res.status);
    }

    const decision = (await res.json()) as {
      allowed: boolean;
      reason: string;
      balance_checked: boolean;
      note?: string;
    };

    if (!decision.allowed) {
      throw new HttpException(
        {
          error: {
            code: `entitlement_denied_${action}`,
            message: `${subject}: ${decision.note ?? decision.reason}`,
            trace_id: randomUUID(),
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }

    // Logged even on success, because "allowed" currently means "nothing was
    // checked" and that must be visible in the journal rather than implied.
    this.logger.log(
      `entitlement ${action} allowed for ${subject} (reason=${decision.reason}, ` +
        `balance_checked=${decision.balance_checked})`,
    );
    return decision;
  }

  /**
   * Describe a gate WITHOUT deciding it: is it actually reading balances, and
   * at what threshold? Listing endpoints use this so a user can see what an
   * arena requires before trying to enter it, rather than after being refused.
   *
   * It asks the same check endpoint with no wallet. The `reason` that comes
   * back names the rule that would decide: `gating_inactive_*` means nothing is
   * read for anyone; `no_wallet_linked` means the token AND a threshold are
   * both configured, so a real wallet would get a real balance read.
   *
   * Unlike `require`, an unreachable arca-service does NOT throw here. A gate
   * status is descriptive, and 502-ing a season listing because the token
   * service is down would take an unrelated read-only endpoint offline over a
   * decision nobody asked for. But it does not fall back to "inactive" either
   * — that would state an unguarded arena as fact when the fact is unknown.
   * `unknown` is its own answer, for exactly the reason `balance_checked`
   * exists.
   */
  async describe(action: string): Promise<GateStatus> {
    const url =
      `${this.arcaUrl}/v1/arca/entitlements/check?action=${encodeURIComponent(action)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decision = (await res.json()) as {
        reason: string;
        required: string | null;
      };
      const active = !decision.reason.startsWith('gating_inactive_');
      return {
        action,
        status: active ? 'active' : 'inactive',
        required: decision.required,
        reason: decision.reason,
      };
    } catch (e) {
      this.logger.warn(
        `could not read the '${action}' gate status from arca-service: ${e} — ` +
          'reporting status=unknown rather than assuming the gate is off',
      );
      return { action, status: 'unknown', required: null, reason: null };
    }
  }

  /** The wallet a token balance would be read against for this creator. */
  async walletForCreator(creatorId: string | null): Promise<string | null> {
    if (!creatorId) return null;
    const rows = await this.db.query(
      `SELECT wallet_address FROM creators WHERE id = $1`,
      [creatorId],
    );
    return rows[0]?.wallet_address ?? null;
  }

  /** The wallet behind an agent, via its creator. */
  async walletForAgent(agentId: string): Promise<string | null> {
    const rows = await this.db.query(
      `SELECT c.wallet_address FROM agents a
       LEFT JOIN creators c ON c.id = a.creator_id
       WHERE a.id = $1`,
      [agentId],
    );
    return rows[0]?.wallet_address ?? null;
  }

  private upstreamError(action: string, message: string, status: number | null) {
    const traceId = randomUUID();
    this.logger.error(
      `entitlement check '${action}' failed (${status ?? 'no response'}) [trace ${traceId}]: ${message}`,
    );
    return new HttpException(
      {
        error: {
          code: 'entitlement_check_unavailable',
          message:
            `Could not verify the '${action}' entitlement: ${message}. ` +
            'The request was neither allowed nor denied.',
          trace_id: traceId,
        },
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
