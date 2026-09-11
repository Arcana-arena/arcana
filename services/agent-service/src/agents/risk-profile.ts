/**
 * The keys the decision engine actually reads out of `risk_profile`.
 *
 * WHY THIS LIST EXISTS AT ALL. `risk_profile` is free-form JSON and no key is
 * rejected — deliberately. An agent is designed by its owner, a whitelist would
 * make every new lever a breaking change for anyone who wrote ahead of it, and
 * an owner may reasonably want to record things the platform has no opinion
 * about.
 *
 * The cost of that freedom is a typo that does nothing. `stoploss_pct` is
 * accepted, stored, and never read — silence, in the one place where silence is
 * indistinguishable from working. An owner who thinks they have set a stop loss
 * and has not is exactly the failure this project keeps writing down.
 *
 * So: nothing is refused, and nothing is silent either. The create and patch
 * responses name every key the engine will not read.
 *
 * TWO COPIES, GUARDED. The authority is `riskLimitsFrom` in
 * services/decision-engine/internal/engine/strategy.go — it is the code that
 * actually reads these. Go and TypeScript cannot share a list, so agents-verify
 * derives the Go side from that function and fails if the two disagree, the
 * same way MANDATE_MAX_CHARS is held to its Go counterpart.
 */
export const RISK_PROFILE_KEYS: readonly string[] = [
  // How much of the book one trade may commit.
  'trade_size_pct', 'tradeSizePct', 'max_risk_per_trade', 'maxRiskPerTrade',
  // Ceiling on one symbol.
  'max_position_pct', 'maxPositionPct',
  // Never spent.
  'cash_floor_pct', 'cashFloorPct',
  // The move required before acting at all.
  'rebalance_band_pct', 'rebalanceBandPct',
  // Standing protective levels, armed on every position opened.
  'stop_loss_pct', 'stopLossPct',
  'take_profit_pct', 'takeProfitPct',
  // The owner's own transaction cost brake. Absent means unmetered.
  'cost_budget_monthly_pct', 'costBudgetMonthlyPct',
];

/**
 * Keys in this profile that nothing will read.
 *
 * Returns [] for an absent or non-object profile: there is nothing to warn
 * about, and inventing a warning would be its own kind of noise.
 */
export function unrecognisedRiskKeys(profile: unknown): string[] {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
  const known = new Set(RISK_PROFILE_KEYS);
  return Object.keys(profile as Record<string, unknown>).filter((k) => !known.has(k));
}
