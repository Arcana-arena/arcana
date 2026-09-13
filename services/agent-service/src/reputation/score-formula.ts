/**
 * The ARCANA Score, computed a second time from a sealed manifest.
 *
 * WHY A SECOND IMPLEMENTATION. The scoring engine (Go) computes a score and
 * writes a manifest naming its formula version, every constant, every input and
 * every output. A reader who is handed that manifest should not have to believe
 * the outputs: this file recomputes them from the manifest's own inputs, with
 * the manifest's own constants — not today's — so a score written under old
 * weights is checked under the weights that were in force when it was written.
 *
 * score-proof-verify is the third implementation, and holds this one and the Go
 * one to each other.
 *
 * FLOATING POINT IS NOT A LOOPHOLE HERE. Go's float64 and JavaScript's number
 * are the same IEEE-754 double, and every step below performs the same
 * operations in the same order as score.go and engine.ContextFromInputs, so the
 * results are equal bit for bit, not merely close.
 */

export const SCORE_SCHEME = 'arcana-score/v1';
export const SCORE_FORMULA_V1 = 'arcana-score-formula/v1';

type Profile = { turnover_lo: number; turnover_hi: number; sell_share_lo: number; sell_share_hi: number };

export type FormulaConstants = {
  w_performance: number;
  w_risk: number;
  w_consistency: number;
  w_regime: number;
  w_creator: number;
  w_longevity: number;
  strategy_floor: number;
  neutral: number;
  perf_scale: number;
  vol_scale: number;
  dd_scale: number;
  consistency_scale: number;
  longevity_ticks: number;
  strategy_min_decisions: number;
  strategy_fit_tolerance: number;
  min_participation_decisions: number;
  min_exposure: number;
  w_strat_turnover: number;
  w_strat_sell_share: number;
  strategy_profiles: Record<string, Profile>;
};

/**
 * The constants of arcana-score-formula/v1, as published. The Go engine writes
 * its own copy into every manifest; score-proof-verify fails if the two differ
 * for any manifest that names v1.
 */
export const FORMULA_V1_CONSTANTS: FormulaConstants = {
  w_performance: 0.35,
  w_risk: 0.25,
  w_consistency: 0.15,
  w_regime: 0.1,
  w_creator: 0.05,
  w_longevity: 0.1,
  strategy_floor: 0.7,
  neutral: 50,
  perf_scale: 0.2,
  vol_scale: 0.05,
  dd_scale: 0.2,
  consistency_scale: 0.04,
  longevity_ticks: 20,
  strategy_min_decisions: 5,
  strategy_fit_tolerance: 0.25,
  min_participation_decisions: 5,
  min_exposure: 0.02,
  w_strat_turnover: 0.6,
  w_strat_sell_share: 0.4,
  strategy_profiles: {
    buy_and_hold: { turnover_lo: 0, turnover_hi: 0.2, sell_share_lo: 0, sell_share_hi: 0.15 },
    momentum: { turnover_lo: 0.35, turnover_hi: 1, sell_share_lo: 0.15, sell_share_hi: 0.65 },
    mean_reversion: { turnover_lo: 0.25, turnover_hi: 1, sell_share_lo: 0.15, sell_share_hi: 0.65 },
  },
};

export type ManifestNav = { ts: string; nav: string; cash: string; seal: string | null };
export type ManifestDecision = { id: number; ts: string; action: string; commitment: string | null };
export type ManifestPeer = { agent_id: string; season_id: string; ts: string; performance_score: number; seal: string | null };

export type ScoreOutputs = {
  performance: number;
  risk: number | null;
  strategy: number;
  regime: number;
  consistency: number | null;
  creator: number;
  longevity: number;
  strategy_multiplier: number;
  ranked: boolean;
  arcana: number | null;
};

export type ScoreManifest = {
  scheme: string;
  formula: string;
  agent_id: string;
  season_id: string;
  ts: string;
  constants: FormulaConstants;
  strategy_type: string;
  nav_series: ManifestNav[];
  decisions: ManifestDecision[];
  creator_peers: ManifestPeer[];
  outputs: ScoreOutputs;
  previous_seal: string | null;
};

const KEYS = [
  'formula', 'agent_id', 'season_id', 'ts', 'constants', 'strategy_type',
  'nav_series', 'decisions', 'creator_peers', 'outputs', 'previous_seal',
] as const;

/**
 * Read a manifest the way any checker would: the scheme line, then one
 * `key: <JSON>` line per field, in a fixed order. A manifest that does not have
 * exactly this shape is refused rather than read loosely.
 */
export function parseScoreManifest(body: string): ScoreManifest {
  const lines = body.replace(/\n$/, '').split('\n');
  if (lines[0] !== SCORE_SCHEME) throw new Error(`not a score manifest: first line is ${JSON.stringify(lines[0])}`);
  if (lines.length !== KEYS.length + 1) throw new Error(`a score manifest has ${KEYS.length + 1} lines; this has ${lines.length}`);
  const out: Record<string, unknown> = { scheme: lines[0] };
  KEYS.forEach((key, i) => {
    const line = lines[i + 1];
    const prefix = `${key}: `;
    if (!line.startsWith(prefix)) throw new Error(`line ${i + 2} should be ${key}, is ${JSON.stringify(line.slice(0, 30))}`);
    out[key] = JSON.parse(line.slice(prefix.length));
  });
  return out as unknown as ScoreManifest;
}

// ---------------------------------------------------------------- arithmetic

/** strconv.ParseFloat, with Go's engine treating a parse error as 0. */
const mustParse = (s: string): number => {
  if (typeof s !== 'string' || s.trim() === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim())) return 0;
  return Number(s);
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 1 − c, computed the way Go computes it for a constant: exactly, in decimal,
 * and only then rounded to a double.
 *
 * WHY THIS IS NOT `1 - c`. In score.go `strategyFloor` is an untyped constant,
 * so `(1-strategyFloor)` is folded at compile time with exact arithmetic and
 * becomes the double nearest 0.3. At run time `1 - 0.7` is 0.30000000000000004,
 * and the strategy multiplier of a score with a checkable strategy then differs
 * in its last bit (0.9967 against the engine's 0.9966999999999999). Reproducing
 * the engine exactly means reproducing that fold.
 */
export const exactOneMinus = (c: number): number => {
  const s = String(c);
  if (!/^\d+(\.\d+)?$/.test(s)) return 1 - c;
  const decimals = s.includes('.') ? s.split('.')[1].length : 0;
  const scale = 10n ** BigInt(decimals);
  const diff = scale - BigInt(s.replace('.', ''));
  const neg = diff < 0n;
  const abs = neg ? -diff : diff;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0');
  return Number(`${neg ? '-' : ''}${whole}${decimals ? `.${frac}` : ''}`);
};
/** Go math.Round: half away from zero. */
const round1 = (v: number) => (v < 0 ? -Math.round(-v * 10) : Math.round(v * 10)) / 10;
const mean = (xs: number[]) => {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};
const stddev = (xs: number[], m: number) => {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return Math.sqrt(s / xs.length);
};
const maxDrawdown = (navs: number[]) => {
  let peak = navs[0];
  let maxDD = 0;
  for (const v of navs) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
};

/** Every intermediate value, so a reader can follow the arithmetic, not only its end. */
export type Working = {
  tick_count: number;
  decision_count: number;
  buys: number;
  sells: number;
  exposure: number;
  exposure_used: number;
  creator_peer_mean: number | null;
  total_return: number | null;
  per_tick_returns: number;
  return_stdev_per_exposure: number | null;
  max_drawdown_per_exposure: number | null;
  turnover: number | null;
  sell_share: number | null;
  strategy_checkable: boolean;
  weighted_sum: number;
};

/**
 * arcana-score-formula/v1, with the constants the manifest carries.
 */
export function recomputeV1(m: Pick<ScoreManifest, 'constants' | 'strategy_type' | 'nav_series' | 'decisions' | 'creator_peers'>): {
  outputs: ScoreOutputs;
  working: Working;
} {
  const c = m.constants;

  // --- engine.ContextFromInputs
  const navs: number[] = [];
  let exposureSum = 0;
  let exposureTicks = 0;
  for (const p of m.nav_series) {
    const nav = mustParse(p.nav);
    navs.push(nav);
    if (nav > 0) {
      let invested = (nav - mustParse(p.cash)) / nav;
      if (invested < 0) invested = 0;
      exposureSum += invested;
      exposureTicks++;
    }
  }
  const exposureMean = exposureTicks > 0 ? exposureSum / exposureTicks : 0;
  let buys = 0;
  let sells = 0;
  for (const d of m.decisions) {
    if (d.action === 'buy') buys++;
    else if (d.action === 'sell') sells++;
  }
  const decisionCount = m.decisions.length;
  let peerMean: number | null = null;
  if (m.creator_peers.length > 0) {
    let sum = 0;
    for (const p of m.creator_peers) sum += p.performance_score;
    peerMean = sum / m.creator_peers.length;
  }

  // --- score.go strategyScore
  let strategy = c.neutral;
  let checkable = false;
  let turnover: number | null = null;
  let sellShare: number | null = null;
  const profile = c.strategy_profiles[m.strategy_type];
  if (profile && decisionCount >= c.strategy_min_decisions) {
    const trades = buys + sells;
    turnover = trades / decisionCount;
    const fit = (v: number, lo: number, hi: number) =>
      v < lo ? clamp01(1 - (lo - v) / c.strategy_fit_tolerance) : v > hi ? clamp01(1 - (v - hi) / c.strategy_fit_tolerance) : 1;
    let sellFit = 1;
    if (trades > 0) {
      sellShare = sells / trades;
      sellFit = fit(sellShare, profile.sell_share_lo, profile.sell_share_hi);
    }
    const turnoverFit = fit(turnover, profile.turnover_lo, profile.turnover_hi);
    strategy = round1((c.w_strat_turnover * turnoverFit + c.w_strat_sell_share * sellFit) * 100);
    checkable = true;
  }
  // (1 − strategy_floor) is a constant expression in score.go, folded exactly.
  const multiplier = checkable ? c.strategy_floor + exactOneMinus(c.strategy_floor) * (strategy / 100) : 1;

  // --- score.go ComputeFactors
  const ranked = decisionCount >= c.min_participation_decisions;
  const regime = c.neutral;
  const longevity = clamp01(navs.length / c.longevity_ticks) * 100;
  const creator = peerMean !== null ? clamp01(peerMean / 100) * 100 : c.neutral;

  let performance = c.neutral;
  let risk = c.neutral;
  let consistency = c.neutral;
  let totalReturn: number | null = null;
  let sdPer: number | null = null;
  let ddPer: number | null = null;
  let exposure = exposureMean;
  const returns: number[] = [];

  if (navs.length > 0) {
    for (let i = 1; i < navs.length; i++) {
      if (navs[i - 1] > 0) returns.push((navs[i] - navs[i - 1]) / navs[i - 1]);
    }
    const first = navs[0];
    const last = navs[navs.length - 1];
    if (first > 0) {
      totalReturn = (last - first) / first;
      performance = clamp01(0.5 + totalReturn / c.perf_scale) * 100;
    }
    if (exposure < c.min_exposure) exposure = c.min_exposure;
    if (returns.length >= 1) {
      sdPer = stddev(returns, mean(returns)) / exposure;
      const volScore = clamp01(1 - sdPer / c.vol_scale) * 100;
      ddPer = maxDrawdown(navs) / exposure;
      const ddScore = clamp01(1 - ddPer / c.dd_scale) * 100;
      risk = round1(0.5 * volScore + 0.5 * ddScore);
      const sd2 = stddev(returns, mean(returns)) / exposure;
      consistency = clamp01(1 - sd2 / c.consistency_scale) * 100;
    }
  }

  // --- Factors.Arcana, terms added in score.go's order
  const weighted =
    c.w_performance * performance +
    c.w_risk * risk +
    c.w_regime * regime +
    c.w_consistency * consistency +
    c.w_creator * creator +
    c.w_longevity * longevity;
  const arcana = round1(weighted * multiplier);

  return {
    outputs: {
      performance,
      risk: ranked ? risk : null,
      strategy,
      regime,
      consistency: ranked ? consistency : null,
      creator,
      longevity,
      strategy_multiplier: multiplier,
      ranked,
      arcana: ranked ? arcana : null,
    },
    working: {
      tick_count: navs.length,
      decision_count: decisionCount,
      buys,
      sells,
      exposure: exposureMean,
      exposure_used: navs.length > 0 ? exposure : exposureMean,
      creator_peer_mean: peerMean,
      total_return: totalReturn,
      per_tick_returns: returns.length,
      return_stdev_per_exposure: sdPer,
      max_drawdown_per_exposure: ddPer,
      turnover,
      sell_share: sellShare,
      strategy_checkable: checkable,
      weighted_sum: weighted,
    },
  };
}

/** The formula as text, per version — what a reader implements to check a score without ARCANA. */
export const FORMULAS: Record<string, { version: string; constants: FormulaConstants; steps: string[]; source: string; notes: string[] }> = {
  [SCORE_FORMULA_V1]: {
    version: SCORE_FORMULA_V1,
    constants: FORMULA_V1_CONSTANTS,
    source: 'services/scoring-engine/internal/engine/score.go and engine/manifest.go (ContextFromInputs)',
    steps: [
      'Inputs are the manifest\'s nav_series (in order), decisions, creator_peers (in order) and strategy_type. Use the manifest\'s constants, not current ones.',
      'navs[i] = nav_series[i].nav as a number (text that is not a number counts as 0).',
      'exposure = mean over ticks with nav > 0 of max(0, (nav − cash) / nav); 0 if there are none.',
      'decision_count = number of decisions; buys and sells = decisions whose action is buy / sell.',
      'creator_peer_mean = sum of creator_peers[].performance_score, added in listed order, divided by their count; absent if there are none.',
      'ranked = decision_count ≥ min_participation_decisions.',
      'strategy: if strategy_profiles has strategy_type and decision_count ≥ strategy_min_decisions — trades = buys + sells, turnover = trades / decision_count, fit(v, lo, hi) = 1 inside [lo, hi], else clamp01(1 − distance / strategy_fit_tolerance); sell_fit = 1 when trades = 0, else fit(sells / trades, sell_share band); strategy = round1((w_strat_turnover · fit(turnover) + w_strat_sell_share · sell_fit) · 100) and it is checkable. Otherwise strategy = neutral, not checkable.',
      'strategy_multiplier = strategy_floor + (1 − strategy_floor) · (strategy / 100) when checkable, else 1. (1 − strategy_floor) involves only constants, so compute it EXACTLY in decimal first (1 − 0.7 = 0.3, then the double nearest 0.3) — not as a floating-point subtraction, which gives 0.30000000000000004 and changes the last bit of the result.',
      'regime = neutral. longevity = clamp01(len(navs) / longevity_ticks) · 100. creator = clamp01(creator_peer_mean / 100) · 100, or neutral.',
      'If there are no navs: performance = risk = consistency = neutral. Otherwise returns[i] = (navs[i] − navs[i−1]) / navs[i−1] for every i ≥ 1 with navs[i−1] > 0.',
      'performance = clamp01(0.5 + ((last − first) / first) / perf_scale) · 100 when first > 0, else neutral.',
      'exposure_used = max(exposure, min_exposure).',
      'With at least one return: sd = population stdev(returns) / exposure_used; risk = round1(0.5 · clamp01(1 − sd / vol_scale) · 100 + 0.5 · clamp01(1 − (max peak-to-trough drawdown of navs / exposure_used) / dd_scale) · 100); consistency = clamp01(1 − sd / consistency_scale) · 100. Without one: both neutral.',
      'arcana = round1((w_performance·performance + w_risk·risk + w_regime·regime + w_consistency·consistency + w_creator·creator + w_longevity·longevity) · strategy_multiplier), adding the terms in exactly that order.',
      'If not ranked, risk, consistency and arcana are recorded as null.',
      'round1(x) = x rounded to one decimal, halves away from zero. clamp01 clips to [0, 1]. Every value is an IEEE-754 double; doing the steps in this order reproduces the manifest\'s outputs exactly.',
    ],
    notes: [
      'regime measures nothing yet: it is the neutral constant for every agent, with a weight.',
      'creator_peers is every score snapshot of the creator\'s OTHER active agents, across all seasons and runs, newest first — not only the latest per agent. That is what the engine has always averaged; the manifest lists each row.',
      'The score row stores numeric(6,2): performance, consistency, longevity and creator are rounded to two decimals when stored, risk, strategy and arcana are already one-decimal values.',
    ],
  },
};
