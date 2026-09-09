import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArcaTokenService } from '../payments/arca-token.service';

/**
 * $ARCA entitlement gating (architecture.md §2.7).
 *
 * The one rule this service exists to keep: **a caller must never be able to
 * mistake "not checked" for "checked and passed."** §2.7 promised this gating
 * layer and it did not exist; agent-service even carried a docstring claiming
 * it verified a CREATE entitlement while verifying nothing. A gate that quietly
 * waves everyone through while looking like a gate is worse than no gate, and
 * that is the failure this design is built against.
 *
 * So every answer carries HOW it was reached: `balance_checked` says whether a
 * balance was actually read, and `reason` names the rule that decided. When the
 * token is not launched the answer is still `allowed: true` — operations must
 * keep working — but it says so in a way no caller can misread.
 *
 * No `arca_accounts` table. An entitlement is "does this wallet hold enough
 * $ARCA", which is a live chain read, not stored state. A table would add a
 * staleness failure mode and a second version of the truth; it earns its place
 * when staking or non-balance grants exist, not before.
 */

/** Actions §2.7 names as gated. */
export const GATED_ACTIONS = [
  'create',
  'compete',
  'evolve',
  'access',
  'marketplace',
  'passport',
  'premium_arena',
] as const;

export type GatedAction = (typeof GATED_ACTIONS)[number];

/** Env var holding the $ARCA threshold for each action. */
const THRESHOLD_ENV: Record<GatedAction, string> = {
  create: 'ARCA_GATE_CREATE',
  compete: 'ARCA_GATE_COMPETE',
  evolve: 'ARCA_GATE_EVOLVE',
  access: 'ARCA_GATE_ACCESS',
  marketplace: 'ARCA_GATE_MARKETPLACE',
  passport: 'ARCA_GATE_PASSPORT',
  premium_arena: 'ARCA_GATE_PREMIUM_ARENA',
};

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface EntitlementDecision {
  action: GatedAction;
  user_id: string | null;
  allowed: boolean;
  /** Names the rule that decided. Never just true/false. */
  reason: string;
  /** Whether an on-chain balance was actually read for this decision. */
  balance_checked: boolean;
  /** Threshold in $ARCA, or null when none is configured. */
  required: string | null;
  /** The wallet's $ARCA balance, or null when it was not read. */
  balance: string | null;
  /** Plain-language note, so a log or UI cannot misreport the decision. */
  note: string;
}

@Injectable()
export class EntitlementService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementService.name);
  private readonly thresholds: Partial<Record<GatedAction, number>> = {};
  private readonly decimals: number;

  constructor(
    private readonly token: ArcaTokenService,
    config: ConfigService,
  ) {
    for (const action of GATED_ACTIONS) {
      const raw = config.get<string>(THRESHOLD_ENV[action]);
      const n = raw != null && raw !== '' ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 0) this.thresholds[action] = n;
    }
    const dec = parseInt(config.get<string>('ARCA_TOKEN_DECIMALS') ?? '18', 10);
    this.decimals = Number.isFinite(dec) && dec >= 0 ? dec : 18;
  }

  onModuleInit() {
    // Same loudness as the listener and payout warnings: the state of this
    // gate has to be visible in the boot log, not inferred from config.
    if (!this.token.enabled) {
      this.logger.warn(
        '$ARCA gating INACTIVE: ARCA_TOKEN_ADDRESS / ARCA_RPC_URL not set — ' +
          'every entitlement check passes WITHOUT balance verification. ' +
          'Expected until the token launches (see docs/arca-go-live.md).',
      );
      return;
    }
    const configured = GATED_ACTIONS.filter((a) => this.thresholds[a] != null);
    const missing = GATED_ACTIONS.filter((a) => this.thresholds[a] == null);
    this.logger.log(
      `$ARCA gating ACTIVE for: ${configured.join(', ') || '(none)'}`,
    );
    if (missing.length > 0) {
      this.logger.warn(
        `$ARCA gating has no threshold for: ${missing.join(', ')} — those actions pass ` +
          'without balance verification until their threshold is set.',
      );
    }
  }

  /** Whether a string names one of the gated actions. */
  isGatedAction(value: string): value is GatedAction {
    return (GATED_ACTIONS as readonly string[]).includes(value);
  }

  /**
   * Decide one entitlement.
   *
   * Order matters. The "gating is off" cases are answered BEFORE the wallet is
   * validated, so that a missing or unlinked wallet cannot block operations
   * while there is nothing to check anyway. After launch the same wallet is a
   * hard requirement — see the `no_wallet_linked` branch.
   */
  async check(action: GatedAction, userId: string | null): Promise<EntitlementDecision> {
    const base = { action, user_id: userId ?? null };

    if (!this.token.enabled) {
      return {
        ...base,
        allowed: true,
        reason: 'gating_inactive_token_not_launched',
        balance_checked: false,
        required: null,
        balance: null,
        note:
          'The $ARCA token is not configured, so no balance was read. This is a pass by ' +
          'default, not a verified entitlement.',
      };
    }

    const required = this.thresholds[action];
    if (required == null) {
      return {
        ...base,
        allowed: true,
        reason: 'gating_inactive_no_threshold_configured',
        balance_checked: false,
        required: null,
        balance: null,
        note:
          `No threshold is configured for '${action}' (${THRESHOLD_ENV[action]} unset), so no ` +
          'balance was read. This is a pass by default, not a verified entitlement.',
      };
    }

    if (!userId || !EVM_ADDRESS.test(userId)) {
      return {
        ...base,
        allowed: false,
        reason: 'no_wallet_linked',
        balance_checked: false,
        required: String(required),
        balance: null,
        note:
          'Gating is active but the actor has no linked EVM wallet, so no balance can be ' +
          'read. Denied because the entitlement cannot be established, not because it failed.',
      };
    }

    const raw = await this.token.balanceOf(userId);
    const balance = this.toDecimal(raw);
    const allowed = Number(balance) >= required;

    return {
      ...base,
      allowed,
      reason: allowed ? 'balance_meets_threshold' : 'balance_below_threshold',
      balance_checked: true,
      required: String(required),
      balance,
      note: allowed
        ? `Wallet holds ${balance} $ARCA against a required ${required}.`
        : `Wallet holds ${balance} $ARCA but ${required} is required for '${action}'.`,
    };
  }

  /**
   * Account view: balance plus every action's standing.
   *
   * Served from the live chain read rather than a stored balance, for the same
   * reason there is no accounts table — a cached balance can be wrong, and a
   * wrong balance in a gate is an entitlement granted or denied on fiction.
   */
  async account(userId: string) {
    const gatingActive = this.token.enabled;
    let balance: string | null = null;
    if (gatingActive && EVM_ADDRESS.test(userId)) {
      balance = this.toDecimal(await this.token.balanceOf(userId));
    }

    const entitlements: Record<string, EntitlementDecision> = {};
    for (const action of GATED_ACTIONS) {
      entitlements[action] = await this.check(action, userId);
    }

    return {
      user_id: userId,
      wallet_valid: EVM_ADDRESS.test(userId),
      gating_active: gatingActive,
      balance,
      balance_checked: balance != null,
      // Repeated at the top level so a UI reading only the header cannot show a
      // balance-backed entitlement that was never balance-backed.
      note: gatingActive
        ? 'Balances are read live from the chain.'
        : 'The $ARCA token is not configured: no balance was read and every entitlement below ' +
          'passes by default.',
      entitlements,
    };
  }

  private toDecimal(value: bigint): string {
    const s = value.toString().padStart(this.decimals + 1, '0');
    const intPart = s.slice(0, -this.decimals);
    const frac = s.slice(-this.decimals).replace(/0+$/, '');
    return frac ? `${intPart}.${frac}` : intPart;
  }
}
