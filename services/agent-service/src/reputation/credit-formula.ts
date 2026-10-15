/**
 * The Agent Credit formula, published as data.
 *
 * WHY THIS EXISTS. The ARCANA Score has been readable as data — constants and
 * steps — since `score-formula.ts`, so a reader can recompute a score from a
 * sealed manifest. The capital reputation (arcana-credit-formula/v1,
 * architecture.md §18) had no such surface: its arithmetic was described only in
 * prose in docs/agent-credit.md, and a reader could not recompute a
 * `capital_reputation` row from its own figures without reading Go.
 *
 * THE GO CODE IS THE AUTHORITY, this is the mirror. The constants below are the
 * ones declared in services/decision-engine/internal/credit/credit.go; the tier
 * table and ceiling are read live from the signer's allowlist, never copied
 * here. infra/verify/credit-formula-verify.mjs parses credit.go and holds this
 * file, and the endpoint that serves it, to the Go constants, and recomputes
 * every stored row from its own inputs. A change to credit.go that is not
 * published here fails that suite.
 *
 * NOTHING HERE IS A TERM IN THE ARCANA SCORE, and the ARCANA Score is not a term
 * here: a scored trading record is a GATE on the higher tiers and nothing else
 * (§17.3). Two dimensions that share inputs are one dimension printed twice.
 */

export const CREDIT_FORMULA_V1 = 'arcana-credit-formula/v1';

export type CreditFormulaConstants = {
  // The four component weights, in points. PROPOSED, not calibrated.
  w_exposure: number;
  w_margin: number;
  w_self_sufficiency: number;
  w_cycles_closed: number;
  // USDG-days across qualifying cycles at which exposure stops adding evidence.
  exposure_full_usdg_days: number;
  // Deleverage steps per 30 days of debt at which self-sufficiency is zero.
  deleverage_rate_zero: number;
  // Qualifying cycles closed by repayment at which that component is full.
  cycles_closed_full: number;
  // The lowest health-factor floor a mandate may set; margin is measured against
  // it, not against the agent's own mandate.
  floor: number;
  // A cycle is evidence only above these.
  qualifying_peak_usdg: number;
  qualifying_duration_hours: number;
  // Under this much history the agent is UNRATED, whatever happened inside it.
  min_history_days: number;
  // How long a failure holds the tier at zero.
  liquidation_hold_days: number;
  stuck_hold_days: number;
  // How old a reputation may be before it stops granting anything.
  stale_after_hours: number;
};

/**
 * The constants of arcana-credit-formula/v1, as published. The Go engine writes
 * these into no manifest — it has none — so credit-formula-verify parses them
 * out of credit.go and fails if this file or the endpoint differs.
 */
export const CREDIT_FORMULA_V1_CONSTANTS: CreditFormulaConstants = {
  w_exposure: 35,
  w_margin: 30,
  w_self_sufficiency: 20,
  w_cycles_closed: 15,
  exposure_full_usdg_days: 25000,
  deleverage_rate_zero: 4,
  cycles_closed_full: 12,
  floor: 1.5,
  qualifying_peak_usdg: 10,
  qualifying_duration_hours: 24,
  min_history_days: 30,
  liquidation_hold_days: 90,
  stuck_hold_days: 30,
  stale_after_hours: 48,
};

/** The formula as text, per version — what a reader implements to check a row. */
export const CREDIT_FORMULAS: Record<
  string,
  { version: string; constants: CreditFormulaConstants; source: string; steps: string[]; notes: string[] }
> = {
  [CREDIT_FORMULA_V1]: {
    version: CREDIT_FORMULA_V1,
    constants: CREDIT_FORMULA_V1_CONSTANTS,
    source:
      'services/decision-engine/internal/credit/credit.go (BuildCycles, Score, TierFor, Limit, StaleAfter); ' +
      'the tier table and ceiling in services/signer/allowlist/robinhood-mainnet.json -> lending.credit and lending.limits',
    steps: [
      'Inputs are one capital_reputation row\'s own figures (inputs.figures) and the cycles they came from (capital_cycles). A cycle opens at the first reading of a position with debt > 0 and closes at the first reading with debt = 0; cycles are rebuilt from capital_positions each scan, never appended.',
      'A cycle is evidence only if its peak_debt_usdg is at least qualifying_peak_usdg (10 USDG) AND its duration is at least qualifying_duration_hours (24). usdg_days, cycles_repaid and the figures below count qualifying cycles only.',
      'The agent is UNRATED, with no score at all, when: it has never borrowed; or less than min_history_days (30) have passed since its first borrow; or it has no qualifying cycle. Unrated holds tier 0 and the API reports why — an absence is not a zero.',
      'evidence_fraction = clamp01(log1p(usdg_days / 100) / log1p(exposure_full_usdg_days / 100)).',
      'share_under_floor = seconds_under_floor / debt_seconds, and 0 when there is no debt time.',
      'depth = 1, or clamp01((lowest_health_factor_worst - 1) / (floor - 1)) when the lowest worst-case health factor is below floor (1.5); liquidation is at 1.0, so a low of 1.25 is half way there.',
      'margin_quality = (1 - share_under_floor) * depth.',
      'deleverage_rate_per_30_debt_days = deleverage_steps / (debt_days / 30); self_sufficiency_quality = clamp01(1 - deleverage_rate_per_30_debt_days / deleverage_rate_zero). With no debt time both qualities are taken as 0.',
      'components: exposure = w_exposure * evidence_fraction; margin = w_margin * margin_quality * evidence_fraction; self_sufficiency = w_self_sufficiency * self_sufficiency_quality * evidence_fraction; cycles_closed = w_cycles_closed * clamp01(cycles_repaid / cycles_closed_full). Margin and self-sufficiency carry the same evidence_fraction as exposure, so a clean record on a small loan is worth as much as there was that could have gone wrong.',
      'score = round(exposure + margin + self_sufficiency + cycles_closed), to the nearest integer with halves away from zero.',
      'TierFor: earned_tier = the highest tier whose min_score is at or below the score and whose min_scored_days the agent\'s scored trading days meet. When a tier the score reaches is gated by min_scored_days, held_because = performance_gate.',
      'A liquidation within liquidation_hold_days (90), or a deleverage the guard needed and could not carry out within stuck_hold_days (30), sets the HELD tier to 0 — held_because liquidation / deleverage_stuck. A gate is not a weight: it outranks the score.',
      'Limit: with credit enabled, an agent whose confirmed_at is older than stale_after_hours (48) is treated as tier 0; otherwise limit = min(max(tier 0\'s limit, the held tier\'s limit), ceiling_usdg). With credit disabled every agent has ceiling_usdg.',
      'clamp01 clips to [0, 1]. Every value is an IEEE-754 double; doing the steps in this order reproduces a row\'s stored components and score exactly.',
    ],
    notes: [
      'The weights are PROPOSED, not calibrated: on the day they were written one agent had ever borrowed (architecture.md §18.1). They are constants in one file so that changing them is one reviewed diff.',
      'The capital reputation never enters the ARCANA Score, and the ARCANA Score is not a term here: a scored trading record is a gate on the higher tiers and nothing else.',
      'Margin is measured against the floor constant (1.5), the lowest a mandate may set, not against the agent\'s own mandate — an owner cannot improve the measurement by lowering the bar it is taken against.',
      'Unrated is a state, not a zero: an agent with no history has no score, and the API says why rather than printing 0.',
      'The gates are not weights: a liquidation or a stuck deleverage can hold the tier at 0 whatever the score.',
      'A capital_reputation row carries the four components and the figures they came from, but no formula version. The constants published here are the ones in force now; attributing a row to the constants it was computed under is not yet recorded (see the follow-up in docs/agent-credit.md).',
    ],
  },
};
