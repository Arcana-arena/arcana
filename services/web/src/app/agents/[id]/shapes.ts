/**
 * The agent-page response shapes, written from the live responses.
 *
 * Kept beside the page rather than in lib/types because these are the shapes of
 * four endpoints that only this page reads, and because several of them carry
 * fields whose whole meaning is "we could not measure this" — `analysed:
 * false`, `not_analysed[]`, `enforced: null`, `price_status`. Those are typed
 * explicitly so the page cannot forget they exist.
 */

export type Passport = {
  agent: {
    id: string;
    name: string;
    version: number | null;
    status: string | null;
    strategy_type: string | null;
    asset_universe?: string | null;
    created_at: string | null;
  };
  creator: { id: string | null; handle: string | null; reputation_score: number | null } | null;
  participation: {
    ranked: boolean;
    threshold_decisions: number | null;
    decisions: number | null;
    trades: number | null;
    status: string | null;
  } | null;
  career: {
    active_since: string | null;
    first_tick: string | null;
    last_tick: string | null;
    seasons_entered: number | null;
    total_ticks: number | null;
    total_decisions: number | null;
    total_trades: number | null;
  } | null;
  decided_by: {
    own: number | null;
    protective: number | null;
    stop_loss: number | null;
    take_profit: number | null;
    unattributed: number | null;
    note: string | null;
  } | null;
  protection: {
    armed: ArmedGuard[];
    unprotected: UnprotectedPosition[];
    note: string | null;
  } | null;
  season_records: Array<Record<string, unknown>> | null;
  score_history: {
    runs: number;
    first: ScorePoint | null;
    peak: ScorePoint | null;
    latest: ScorePoint | null;
    series: ScorePoint[];
    truncated: boolean;
  } | null;
  dna: DnaBlock | null;
  lineage: {
    version: number | null;
    ancestors: Array<{ id: string; name: string; version: number; status: string; created_at: string }>;
    descendants: Array<{ id: string; name: string; version: number; status: string; created_at: string }>;
    is_original: boolean;
  } | null;
  evolution: { versions: EvolutionVersion[]; comparisons: EvolutionComparison[]; caveat: string | null } | null;
  badges: Array<{ code: string; label: string; criterion: string }> | null;
};

export type ScorePoint = {
  ts: string;
  season_id?: string | null;
  arcana_score: number | null;
  performance_score?: number | null;
  risk_score?: number | null;
  consistency_score?: number | null;
  strategy_score?: number | null;
  longevity_score?: number | null;
  [k: string]: unknown;
};

/** Both scales, because 0.15 and 0.15% are not the same number. */
export type ArmedGuard = {
  symbol: string;
  entry_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  stop_loss_fraction: number | null;
  stop_loss_percent: number | null;
  take_profit_fraction: number | null;
  take_profit_percent: number | null;
  set_at: string | null;
  held_back_since: string | null;
  held_back_because: string | null;
};

export type UnprotectedPosition = {
  symbol: string;
  entry_price: number | null;
  smallest_accepted_fraction: number | null;
  smallest_accepted_percent: number | null;
  because: string | null;
};

export type DnaBlock = {
  computed_at?: string | null;
  features?: Record<string, number | null> | null;
  fingerprint?: {
    dimensions: number;
    features_used: number;
    features: Record<string, number | null>;
    summary: string[];
  } | null;
  risk_personality?: Record<string, number | null> | null;
  regime_strengths?: Record<string, { ticks: number; agent_return_pct: number | null; market_return_pct: number | null }> | null;
};

export type DnaResponse = {
  agent_id: string;
  agent_name: string;
  declared_strategy_type: string | null;
  computed_at: string | null;
  fingerprint: {
    dimensions: number;
    features_used: number;
    features: Record<string, number | null>;
    summary: string[];
  } | null;
  risk_personality: Record<string, number | null> | null;
  regime_strengths: Record<string, { ticks: number; agent_return_pct: number | null; market_return_pct: number | null }> | null;
};

export type SimilarResponse = {
  agent_id: string;
  neighbours: Array<{
    agent_id: string;
    agent_name: string;
    declared_strategy_type: string | null;
    similarity: number;
  }>;
};

export type EvolutionVersion = {
  agent_id: string;
  version: number;
  status: string;
  config: Record<string, unknown>;
  created_at: string;
  ranked: boolean;
  window: { first_tick: string | null; last_tick: string | null } | null;
  activity: { ticks: number; decisions: number; trades: number; turnover: number; avg_exposure: number } | null;
  performance: Record<string, number | null> | null;
};

export type EvolutionComparison = {
  from_version: number;
  to_version: number;
  config_changed: { changed: boolean; fields: Record<string, { from: unknown; to: unknown }> } | null;
  behaviour: { dna_similarity: number | null; reading: string | null } | null;
  deltas: Record<string, { before: number | null; after: number | null; change: number | null }> | null;
};

export type EvolutionResponse = {
  agent_id: string;
  lineage_root: string | null;
  versions: EvolutionVersion[];
  comparisons: EvolutionComparison[];
  caveat: string | null;
};

/** One trade inside the worst drawdown, with who decided it. */
export type DrawdownTrade = {
  ts: string;
  action: string | null;
  symbol: string | null;
  quantity: number | null;
  rationale: string | null;
  decider?: string | null;
  reason_code?: string | null;
  decided_by?: DecidedBy | null;
};

/** A section the autopsy deliberately did not analyse, and why. */
export type NotAnalysed = { section: string; reason: string };

export type Autopsy = {
  agent: { id: string; name: string; version: number | null; status: string | null; strategy_type: string | null };
  analysed: boolean;
  reason?: string | null;
  summary: {
    ticks: number | null;
    decisions: number | null;
    trades: number | null;
    protective_exits: number | null;
    trades_including_protective: number | null;
    first_tick: string | null;
    last_tick: string | null;
    first_nav: number | null;
    last_nav: number | null;
    return_pct: number | null;
  } | null;
  protective_exits: {
    count: number | null;
    share_of_trades: number | null;
    by_level: Record<string, number> | null;
    note: string | null;
    excluded_from: string[] | null;
  } | null;
  allocation: {
    by_symbol: Array<{ symbol: string; pnl: number | null; pct_of_starting_nav: number | null }> | null;
    cash: { pnl?: number | null; pct_of_starting_nav: number | null; method: string | null; sign: string | null } | null;
    evidence: { ticks_paired: number | null; note: string | null } | null;
  } | null;
  decision_timing: { analysed: boolean; trades?: number | null; reason?: string | null; [k: string]: unknown } | null;
  risk: {
    analysed: boolean;
    reason?: string | null;
    max_drawdown_pct?: number | null;
    peak?: { ts: string; nav: number } | null;
    trough?: { ts: string; nav: number } | null;
    duration_ticks?: number | null;
    recovered?: boolean | null;
    recovered_at?: string | null;
    recovery_ticks?: number | null;
    decisions_during_drawdown?: {
      trades: number | null;
      sample: DrawdownTrade[] | null;
      note: string | null;
    } | null;
  } | null;
  volatility: Record<string, number | string | null> | null;
  market_regime: {
    available: boolean;
    reason?: string | null;
    source?: string | null;
    computed_at?: string | null;
    [k: string]: unknown;
  } | null;
  historical_decisions: {
    actions: Record<string, number> | null;
    turnover: number | null;
    longest_hold_streak_ticks: number | null;
    symbols_traded: string[] | null;
  } | null;
  not_analysed: NotAnalysed[] | null;
  market_provenance: { sources: string[] | null; simulated: boolean | null } | null;
  caveat: string | null;
};

/**
 * Who decided a decision, as the backend now reports it.
 *
 * `decider` and `reason_code` are the columns verbatim — null means the row does
 * not say, and is never to be read as the agent having decided. The `decided_by`
 * block is the backend's reading of those two together, which is NOT the same as
 * renaming `decider`: a protective row that is a HOLD is a level that was
 * crossed and NOT acted on, which is close to the opposite of an exit.
 */
export type DecidedBy = {
  category: 'agent' | 'protective_exit' | 'protective_held_back' | 'protective_other' | 'unattributed';
  label: string;
  note: string;
  decider: string | null;
  reason_code: string | null;
};

/** The falsifiable part of a decision, as the model wrote it. */
export type Thesis = {
  claim?: string | null;
  confidence?: number | null;
  horizon_ticks?: number | null;
  invalidated_if?: string | null;
  [k: string]: unknown;
};

export type DecisionRow = {
  ts: string;
  season_id: string | null;
  action: string;
  decision_id?: number | null;
  decider?: string | null;
  reason_code?: string | null;
  decided_by?: DecidedBy | null;
  thesis?: Thesis | null;
  model?: { provider: string | null; model: string | null; model_version: string | null } | null;
  execution?: {
    tx_hash: string | null;
    status: string | null;
    refusal_code: string | null;
    slippage_bps: number | null;
    gas_cost_usd: number | null;
    block_number: number | null;
  } | null;
  symbol: string;
  quantity: number | null;
  price: number | null;
  price_status: string | null;
  notional: number | null;
  rationale: string | null;
  resulting_allocation: Record<string, number> | null;
  evidence: {
    market_snapshot_ref?: string | null;
    content_hash?: string | null;
    source?: string | null;
    ingest_mode?: string | null;
    tick_time?: string | null;
    snapshot_url?: string | null;
    prompt_hash?: string | null;
    response_hash?: string | null;
    evidence_url?: string | null;
    [k: string]: unknown;
  } | null;
};

/** The prompt and the raw model answer behind one decision. */
export type Evidence = {
  decision_id: number;
  ts: string;
  action: string;
  symbol: string | null;
  rationale: string | null;
  thesis: Thesis | null;
  model: { provider: string | null; model: string | null; model_version: string | null; params: unknown; note: string | null };
  prompt: { hash: string | null; body: string | null; bytes: number | null; note: string | null };
  response: { hash: string | null; body: string | null; bytes: number | null; note: string | null };
  market_snapshot_ref: string | null;
};

export type DecisionsResponse = {
  agent_id: string;
  agent_name: string;
  series: string;
  threshold_decisions: number | null;
  ranked: boolean;
  prices: { status: string; reason: string | null; missing_refs: string[] } | null;
  page: number;
  page_size: number;
  total_decisions: number;
  total_pages: number;
  seasons: Array<{ season_id: string; season_name: string; start_at: string; end_at: string; market_sources?: string[] }>;
  decisions: DecisionRow[];
};

export type NavSeries = {
  agent_id: string;
  agent_name: string;
  series: string;
  decisions: number;
  threshold_decisions: number;
  ranked: boolean;
  resolution: { mode: string; bucket: string | null; reason: string };
  range: { from: string | null; to: string | null };
  page: number;
  page_size: number;
  total_points: number;
  total_pages: number;
  stored_points: number;
  seasons: Array<{ season_id: string; season_name: string; start_at: string; end_at: string; market_sources?: string[] }>;
  points: Array<{ ts: string; season_id: string | null; agg?: string | null; nav?: number | null; arcana_score?: number | null }>;
};
