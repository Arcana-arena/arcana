/**
 * The shapes the marketplace endpoints return.
 *
 * Written out rather than inferred, because every one of these fields exists to
 * keep two things apart that a looser type would let collapse: a withheld score
 * from a low one, an unmeasured return from a flat one, a listing that is off
 * from one that can never be bought.
 */

export type SeriesPoint = { ts: string; nav: number; agg: 'min' | 'max' };

export type Performance = {
  available: boolean;
  reason: string | null;
  measured: boolean;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  age_days: number | null;
  points: number;
  series: SeriesPoint[];
  note: string | null;
};

export type UnbuyableReason =
  | 'listing_inactive'
  | 'creator_has_no_wallet'
  | 'agent_retired'
  | 'agent_paused'
  | 'agent_draft'
  | null;

export type BrowseItem = {
  listing_id: string;
  agent_id: string;
  agent_name: string | null;
  agent_version: number | null;
  agent_status: string | null;
  strategy_type: string | null;
  asset_universe: string | null;
  agent_created_at: string | null;
  creator: { id: string; handle: string | null; has_wallet: boolean } | null;
  access_type: string | null;
  price_usd: number | null;
  arca_gate_amount: number | null;
  active: boolean;
  buyable: boolean;
  not_buyable_because: UnbuyableReason;
  not_buyable_note: string | null;
  subscribers: { active: number; grace: number; ever: number };
  score: number | null;
  rank: number | null;
  ranked: boolean | null;
  unranked_note: string | null;
  scoring_known: boolean;
  absent_from_leaderboard: boolean;
  performance: Performance;
};

export type BrowseResponse = {
  sort: string;
  sorted: boolean;
  sort_note: string;
  unsortable_rows: number | null;
  counts: {
    listings: number;
    buyable: number;
    inactive: number;
    active_but_unbuyable: number;
    creators_without_wallet: number;
  };
  facets: {
    strategy_type: Array<{ value: string; listings: number }>;
    asset_universe: Array<{ value: string; listings: number }>;
  };
  performance_source: string | null;
  performance_unavailable_reason: string | null;
  scoring_source: string | null;
  scoring_unavailable_reason: string | null;
  items: BrowseItem[];
  as_of: string;
};

export type ListingDetail = BrowseItem & {
  mandate: string | null;
  risk_personality: Record<string, unknown> | null;
  risk_note: string;
  traded_symbols: Array<{ symbol: string; decisions: number }>;
  traded_symbols_note: string;
  pool_minimum_fraction: number | null;
  pool_minimum_percent: number | null;
  pool_minimum_note: string;
  revenue_share_creator: number | null;
};

/** What a buyer must send, and to whom. Nothing here is computed in the browser. */
export type Quote = {
  listing_id: string;
  pay_to: string;
  token: string;
  amount: string;
  amount_base_units: string;
  decimals: number;
  claim_within_hours: number;
  min_confirmations: number;
  term_days: number;
  grace_hours: number;
  warning: string;
};

export type Terms = {
  term_days: number;
  grace_hours: number;
  claim_within_hours: number;
  min_confirmations: number;
  approx_confirmation_seconds: number;
  payments_configured: boolean;
  payment_token: string | null;
  payment_token_source: string;
  chain: string;
  refundable: false;
  refund_note: string;
  unconfigured_note: string | null;
};

/**
 * What a claim came back with.
 *
 * THE FAILURE BRANCH CARRIES THE WHOLE BODY, deliberately. Three of the codes
 * below are separate screens in the design and each needs fields the others do
 * not have — the shortfall, where the money actually went, what the hash
 * already bought. A single `reason` string could not draw any of them.
 */
export type ClaimOutcome =
  | { kind: 'granted'; data: { listing_id: string; tx_hash: string; amount: string; confirmations: number; expires_at: string } }
  | { kind: 'pending'; body: PendingBody }
  | { kind: 'short'; body: ShortBody }
  | { kind: 'wrong_recipient'; body: WrongRecipientBody }
  | { kind: 'already_used'; body: AlreadyUsedBody }
  | { kind: 'other'; code: string | null; status: number | null; reason: string; body: Record<string, unknown> | null };

export type PendingBody = {
  message: string;
  confirmations: number;
  required_confirmations: number;
  remaining_confirmations: number;
  estimated_seconds_remaining: number;
  block_number: string;
  chain_head: string;
};

export type ShortBody = {
  message: string;
  paid: string | null;
  required: string | null;
  shortfall: string | null;
  paid_base_units: string;
  required_base_units: string;
  shortfall_base_units: string;
  decimals: number | null;
  tx_hash: string;
  remedy: string;
};

export type WrongRecipientBody = {
  message: string;
  expected_recipient: string;
  expected_token: string;
  wrong_recipient: boolean;
  decimals: number | null;
  transfers: Array<{
    to: string;
    from: string;
    token: string;
    amount_base_units: string;
    amount: string | null;
    right_token: boolean;
    right_recipient: boolean;
  }>;
};

export type AlreadyUsedBody = {
  message: string;
  tx_hash: string;
  claimed_listing_id: string;
  claimed_agent_id: string | null;
  claimed_agent_name: string | null;
  claimed_creator_handle: string | null;
  claimed_by_wallet: string;
  claimed_at: string | null;
  term: { expires_at: string; status: string; in_grace: boolean } | null;
  remedy: string;
};

export type Unclaimed = {
  listing_id: string;
  searched_blocks: number;
  searched_minutes: number;
  candidates: Array<{ tx_hash: string; amount_base_units: string; sufficient: boolean }>;
  note: string;
};

/** One row of GET /v1/subscriptions/:wallet, as arca-service now returns it. */
export type MySubscription = {
  id: string;
  userWallet: string;
  listingId: string | null;
  agentId: string | null;
  walletAddress: string | null;
  expiresAt: string;
  status: string;
  tradingPaused: boolean;
  trading: boolean;
  phase: 'active' | 'grace' | 'ended';
  grace_ends_at: string;
  days_remaining: number | null;
  hours_remaining: number | null;
  grace_hours_remaining: number | null;
  term_days: number;
  grace_hours: number;
  agent: {
    id: string;
    name: string | null;
    version: number | null;
    status: string | null;
    strategy_type: string | null;
    asset_universe: string | null;
    creator: { id: string; handle: string | null } | null;
  } | null;
  listing: {
    id: string;
    price_usd_now: number | null;
    active: boolean;
    access_type: string | null;
    arca_gate_amount: number | null;
  } | null;
  receipt: {
    tx_hash: string;
    amount_base_units: string;
    block_number: string;
    block_time: string | null;
    confirmations: number;
  } | null;
  receipt_note: string | null;
  wallet_pnl: {
    computable: boolean;
    reason: string | null;
    first_nav: number | null;
    last_nav: number | null;
    pnl: number | null;
    pnl_pct: number | null;
    points: number;
  };
  next_step: string;
};

/** GET /v1/subscriptions/:id/book — what the agent left in the buyer's wallet. */
export type SubscriptionBook = {
  book: {
    as_of: string;
    nav: number | null;
    cash: number | null;
    holdings: Record<string, number>;
    after_decision: number | null;
  } | null;
  executions: Array<{
    id: number;
    ts: string;
    intent_action: string | null;
    symbol: string | null;
    status: string | null;
    tx_hash: string | null;
    filled_out: string | null;
    slippage_bps: number | null;
    gas_cost_usd: number | null;
  }>;
  protection: {
    armed: Array<Record<string, unknown>>;
    unprotected: Array<Record<string, unknown>>;
    note: string;
  };
  note: string;
};
