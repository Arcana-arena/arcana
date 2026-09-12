/**
 * The shapes the services actually return.
 *
 * Written from the responses themselves, not from wishes. Anything optional is
 * `| null` rather than `?` where the API sends an explicit null, because those
 * two mean different things here: a missing key is a contract change worth
 * noticing, a null is the backend saying "there is no value" on purpose.
 */

export type Paged<T> = {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

/* ------------------------------------------------------------- leaderboard */

export type LeaderboardCategory = {
  key: string;
  label: string;
  about: string;
};

export type LeaderboardRow = {
  rank: number | null;
  agent_id: string;
  agent_name: string;
  version: number | null;
  status: string | null;
  strategy_type: string | null;
  creator: { id: string | null; handle: string | null } | null;
  score: number | null;
  scores: Record<string, number | null>;
  decisions: number | null;
  ranked: boolean;
  unranked_note: string | null;
  as_of: string | null;
};

export type LeaderboardResponse = {
  season: { id: string; name: string; status?: string } | null;
  category: string;
  category_column: string;
  category_about: string;
  categories: LeaderboardCategory[];
  include_unranked: boolean;
  threshold_decisions: number | null;
  total: number;
  total_ranked: number;
  total_unranked: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: LeaderboardRow[];
  note: string | null;
  regime_note: string | null;
  as_of?: string | null;
};

/* ----------------------------------------------------------------- seasons */

export type SeasonAccessGate = {
  action: string;
  required_arca?: number | null;
  [k: string]: unknown;
};

export type Season = {
  id: string;
  name: string;
  universe: string;
  startAt: string;
  endAt: string;
  accessTier: string;
  progress: {
    status: 'upcoming' | 'running' | 'ended' | string;
    competitions: number;
    participants: number;
  } | null;
  access: {
    tier: string;
    gates: SeasonAccessGate[];
    enforced: boolean | null;
    required_arca: number | null;
    note?: string | null;
  } | null;
};

export type Competition = {
  id: string;
  seasonId?: string;
  season_id?: string;
  name?: string;
  type?: string;
  status: string;
  startAt?: string;
  endAt?: string;
  participantIds?: string[];
  participant_ids?: string[];
};

/* ------------------------------------------------------------------ agents */

export type Agent = {
  id: string;
  creatorId: string;
  name: string;
  version: number;
  parentAgentId: string | null;
  strategyType: string;
  riskProfile: Record<string, number> | null;
  assetUniverse: string;
  mandate: unknown;
  mandateTemplate: string | null;
  mandateParams: Record<string, unknown> | null;
  mandateSource: string | null;
  status: string;
  provenance: string | null;
  createdAt: string;
};

export type SeriesPoint = {
  ts: string;
  season_id: string | null;
  agg?: string | null;
  nav?: number | null;
  arcana_score?: number | null;
  [k: string]: unknown;
};

export type SeriesResponse = {
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
  points: SeriesPoint[];
};

export type Decision = {
  ts: string;
  season_id: string | null;
  action: string;
  symbol: string;
  quantity: number | null;
  price: number | null;
  price_status: string | null;
  notional: number | null;
  rationale: string | null;
  resulting_allocation: Record<string, number> | null;
  decided_by?: string | null;
  evidence: Record<string, unknown> | null;
  execution?: Record<string, unknown> | null;
  [k: string]: unknown;
};

export type DecisionsResponse = {
  agent_id: string;
  agent_name: string;
  series: string;
  decisions: Decision[];
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
  [k: string]: unknown;
};

/* ------------------------------------------------------------- marketplace */

export type Listing = {
  id: string;
  agent_id?: string;
  agentId?: string;
  status: string;
  price_arca?: number | null;
  priceArca?: number | null;
  [k: string]: unknown;
};
