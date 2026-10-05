import { DataSource } from 'typeorm';
import { readAllowlist } from './allowlist';

/**
 * AGENT CREDIT (architecture.md §18): an agent's capital reputation, the tier
 * it holds, and the debt limit that tier gives.
 *
 * NOTHING IS SCORED HERE. The position guard computes the cycles and the
 * reputation (services/decision-engine/internal/credit) and writes them; this
 * returns those rows. A second implementation of the score would agree with the
 * first on every day it still agreed.
 *
 * ONE THING IS COMPUTED, and it mirrors credit.Limit in the engine line for
 * line: the limit a tier gives, read from the signer's allowlist at the moment
 * of asking. It is not taken from the stored row, because the row records what
 * the limit was when it was written and the allowlist may have changed since —
 * and the engine, which is what actually refuses a borrow, reads the allowlist.
 *
 * BESIDE THE ARCANA SCORE, NEVER INSIDE IT (§17.3), and the ARCANA Score is not
 * inside this one either.
 */

/** Mirrors credit.StaleAfter: a reputation nobody has re-checked grants nothing. */
export const CREDIT_STALE_AFTER_SECONDS = 48 * 3600;

export type CreditConfig = {
  enabled: boolean;
  /** The signer's per-agent cap: the number no tier may exceed. */
  ceiling_usdg: number;
  tiers: Array<{ tier: number; min_score: number; max_debt_usdg: number; min_scored_days: number }>;
};

export function creditConfig(): CreditConfig {
  const l = readAllowlist().lending;
  return {
    enabled: l?.credit?.enabled === true,
    ceiling_usdg: l ? Number(l.limits.max_debt_per_agent_usdg) : 0,
    tiers: (l?.credit?.tiers ?? []).map((t) => ({
      tier: t.tier,
      min_score: t.min_score,
      max_debt_usdg: Number(t.max_debt_usdg),
      min_scored_days: t.min_scored_days ?? 0,
    })),
  };
}

/**
 * The debt limit, in whole USDG, for an agent holding `tier` as last confirmed
 * at `confirmedAt`. With credit disabled it is the platform's cap for everyone,
 * as it was before §18. With it enabled, a missing or stale reputation is
 * tier 0, and no tier is above the ceiling.
 */
export function limitForTier(cfg: CreditConfig, tier: number, confirmedAt: Date | null, now = new Date()): number {
  if (!cfg.enabled || cfg.tiers.length === 0) return cfg.ceiling_usdg;
  const stale = !confirmedAt || (now.getTime() - confirmedAt.getTime()) / 1000 > CREDIT_STALE_AFTER_SECONDS;
  const held = stale ? 0 : tier;
  let limit = 0;
  for (const t of cfg.tiers) {
    if (t.tier === 0 || t.tier === held) limit = Math.max(limit, t.max_debt_usdg);
  }
  return Math.min(limit, cfg.ceiling_usdg);
}

export const HELD_BECAUSE: Record<string, string> = {
  liquidation: 'A position was liquidated in the last 90 days. That holds the tier at 0 whatever the score.',
  deleverage_stuck:
    'In the last 30 days the guard needed to deleverage a position and could not. That holds the tier at 0.',
  performance_gate:
    'The score reaches a higher tier, and that tier also requires a longer scored trading record than this agent has.',
};

export async function creditFor(db: DataSource, agentId: string) {
  const cfg = creditConfig();
  const now = new Date();

  const repRows = await db.query(
    `SELECT computed_at, confirmed_at, rated, unrated_why, score, components, inputs,
            earned_tier, tier, held_because, limit_usdg::float8 AS limit_usdg
       FROM capital_reputation WHERE agent_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [agentId]);
  const rep = repRows[0] ?? null;

  const cycles = await db.query(
    `SELECT market_id, opened_at, closed_at,
            peak_debt_usdg::float8 AS peak_debt_usdg, usdg_days::float8 AS usdg_days,
            debt_seconds::float8 AS debt_seconds, seconds_under_floor::float8 AS seconds_under_floor,
            lowest_health_factor_worst::float8 AS lowest_health_factor_worst,
            borrowed_usdg::float8 AS borrowed_usdg, repaid_usdg::float8 AS repaid_usdg,
            interest_usdg::float8 AS interest_usdg, deleverage_steps, liquidations, closed_how
       FROM capital_cycles WHERE agent_id = $1 ORDER BY opened_at DESC LIMIT 50`, [agentId]);
  const cycleCounts = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
            count(*) FILTER (WHERE closed_how = 'repaid')::int AS repaid,
            count(*) FILTER (WHERE closed_how = 'deleveraged')::int AS deleveraged,
            count(*) FILTER (WHERE closed_how = 'liquidated')::int AS liquidated
       FROM capital_cycles WHERE agent_id = $1`, [agentId]);

  const liquidations = await db.query(
    `SELECT market_id, ts, block_number::text AS block_number, tx_hash, liquidator,
            repaid_usdg::float8 AS repaid_usdg, seized_qty::float8 AS seized_qty,
            bad_debt_usdg::float8 AS bad_debt_usdg
       FROM capital_liquidations WHERE agent_id = $1 ORDER BY ts DESC`, [agentId]);
  // WHETHER LIQUIDATIONS ARE BEING READ AT ALL. A count of zero is a
  // measurement only if the event scan has run; before it has, zero would be
  // "not detected" printed as "none".
  const cursor = await db.query(
    `SELECT max(updated_at) AS scanned_at, min(block_number)::text AS scanned_to FROM capital_scan_cursors`);
  const scannedAt: Date | null = cursor[0]?.scanned_at ?? null;

  const confirmedAt: Date | null = rep ? new Date(rep.confirmed_at) : null;
  const stale = !!confirmedAt && (now.getTime() - confirmedAt.getTime()) / 1000 > CREDIT_STALE_AFTER_SECONDS;
  const tier = rep && !stale ? rep.tier : 0;
  const limit = limitForTier(cfg, rep?.tier ?? 0, confirmedAt, now);

  const status = !rep ? 'no_record' : rep.rated ? 'rated' : 'unrated';
  return {
    // Whether the tier moves the limit. While it is false the reputation is
    // shown and every agent has the platform's cap.
    enabled: cfg.enabled,
    status,
    score: rep?.rated ? rep.score : null,
    // The engine's own words for an agent it has a row for; the same words for
    // one that never borrowed and so has no row at all.
    unrated_why: !rep ? 'this agent has never borrowed' : rep.rated ? null : rep.unrated_why,
    // The working: the four components in points, and the figures they came from.
    components: rep?.rated ? rep.components : null,
    inputs: rep?.inputs ?? null,
    tier,
    earned_tier: rep?.earned_tier ?? 0,
    held_because: rep?.held_because ?? null,
    held_because_note: rep?.held_because ? HELD_BECAUSE[rep.held_because] ?? null : null,
    limit_usdg: limit,
    ceiling_usdg: cfg.ceiling_usdg,
    tiers: cfg.tiers,
    computed_at: rep?.computed_at ?? null,
    confirmed_at: rep?.confirmed_at ?? null,
    stale,
    cycles: {
      ...(cycleCounts[0] ?? { total: 0, open: 0, repaid: 0, deleveraged: 0, liquidated: 0 }),
      list: cycles,
      truncated: (cycleCounts[0]?.total ?? 0) > cycles.length,
    },
    liquidations: {
      // null until the event scan has run once: not detected is not none.
      count: scannedAt ? liquidations.length : null,
      scanned_at: scannedAt,
      scanned_to_block: cursor[0]?.scanned_to ?? null,
      list: liquidations,
    },
    note: cfg.enabled
      ? 'The capital reputation is computed by the position guard from this agent\'s own loans. Its tier sets the ' +
        'most the agent may owe; collateral and the mandate\'s health floor still bound every borrow.'
      : 'The capital reputation is computed by the position guard from this agent\'s own loans. It is shown and ' +
        `does not yet move any limit: every agent may owe at most ${cfg.ceiling_usdg} USDG.`,
  };
}
