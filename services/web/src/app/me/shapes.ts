/**
 * The shapes the creator dashboard reads.
 *
 * Written out rather than inferred, because nearly every optional field here
 * separates two things a looser type would let collapse: a stop that is armed
 * from one that is watched, an unread balance from an empty one, a creator who
 * has earned nothing from one who was never payable.
 */

export type AttentionKind =
  | 'paused_by_meter'
  | 'unguarded_position'
  | 'guard_held_back'
  | 'no_wallet'
  | 'unranked'
  | 'quiet';

export type Attention = {
  agent_id: string;
  agent_name: string | null;
  kind: AttentionKind;
  detail: string;
  since: string | null;
};

export type DashboardAgent = {
  id: string;
  name: string;
  version: number;
  status: string;
  strategy_type: string | null;
  asset_universe: string | null;
  created_at: string | null;
  parent_agent_id: string | null;
  mandate: string | null;
  risk_profile: Record<string, unknown> | null;
  /** The engine's last written score — NOT the leaderboard's published one. */
  latest_score: number | null;
  latest_score_at: string | null;
  ranked: boolean;
  decisions: number;
  decisions_needed_to_rank: number;
  last_decision_at: string | null;
  nav: number | null;
  cash: number | null;
  nav_at: string | null;
  listing: {
    id: string;
    price_usd: number | null;
    active: boolean;
    subscribers_active: number;
    subscribers_grace: number;
  } | null;
  wallet: { address: string; key_custody: string | null } | null;
  last_reason_code: string | null;
  guards: { armed: number; held_back: number; refused: number };
};

export type Dashboard = {
  creator: {
    id: string;
    handle: string;
    wallet_address: string | null;
    can_be_paid: boolean;
    reputation_score: number | null;
    status: string;
    created_at: string | null;
  };
  slots: { active: number; cap: number; free: number; counts: string; note: string };
  agents: DashboardAgent[];
  attention: Attention[];
  attention_note: string;
  as_of: string;
};

export type Earnings = {
  available: boolean;
  reason: string | null;
  payable?: boolean;
  payable_note?: string | null;
  totals: {
    payments: number;
    base_units: string;
    amount: string | null;
    payments_30d: number;
    amount_30d: string | null;
    first_payment: string | null;
    last_payment: string | null;
    token: string | null;
    decimals: number | null;
    decimals_note: string | null;
  } | null;
  by_week: Array<{ week: string; payments: number; base_units: string; amount: string | null }>;
  by_week_note?: string;
  recent: Array<{
    tx_hash: string;
    buyer_wallet: string;
    base_units: string;
    amount: string | null;
    block_time: string | null;
    block_number: string | null;
    listing_id: string | null;
    agent_id: string | null;
    agent_name: string | null;
  }>;
  subscribers: {
    active: number;
    grace: number;
    ever: number;
    distinct_wallets: number;
    note: string;
  } | null;
  other_tokens?: Array<{ token_address: string; payments: number }>;
  other_tokens_note?: string | null;
};

export type WalletBalances = {
  agent_id: string;
  address: string | null;
  has_wallet: boolean;
  key_custody?: string | null;
  note?: string | null;
  token: { available: boolean; reason: string | null; amount: string | null; raw: string | null; decimals?: number | null; address?: string | null } | null;
  native: { available: boolean; reason: string | null; amount: string | null; raw: string | null; symbol?: string } | null;
  gas: {
    known: boolean;
    reason: string | null;
    median_gas_wei: string | null;
    measured_from?: number;
    executions_last_7d?: number;
    transactions_affordable: number | null;
    low: boolean | null;
    note?: string | null;
  } | null;
};

export type WalletTransactions = {
  agent_id: string;
  items: Array<{
    id: number;
    ts: string | null;
    action: string | null;
    symbol: string | null;
    status: string | null;
    tx_hash: string | null;
    block_number: string | null;
    amount_in: string | null;
    filled_out: string | null;
    gas_cost_usd: number | null;
    gas_cost_wei: string | null;
    gas_note: string | null;
    slippage_bps: number | null;
    pool_fee_usd: number | null;
    fired_by_guard: boolean;
    refusal_code: string | null;
    note: string | null;
  }>;
  totals: { executions: number; mined: number; failed: number; never_sent: number; unpriced: number };
  completeness: string;
};

export type Triggers = {
  agent_id: string;
  agent_status: string;
  armed: Array<{
    id: number;
    kind: 'protective_level';
    symbol: string;
    stop_loss_price: number | null;
    stop_loss_fraction: number | null;
    stop_loss_percent: number | null;
    take_profit_price: number | null;
    take_profit_fraction: number | null;
    take_profit_percent: number | null;
    entry_price: number | null;
    set_at: string | null;
    held_back_since: string | null;
    held_back_because: string | null;
    /** False when the agent is not active — the watcher only reads active agents. */
    watched: boolean;
    watched_note: string | null;
  }>;
  refused: Array<{
    id: number;
    kind: 'protective_level_refused';
    symbol: string;
    smallest_accepted_fraction: number | null;
    smallest_accepted_percent: number | null;
    because: string | null;
  }>;
  cost_meter: { armed: boolean; budget_monthly_pct: number | null; note: string; evaluated?: string };
  fired: Array<{ at: string | null; what: string; outcome: string; decision_id: number | null }>;
  not_available: Array<{ condition: string; action: string; missing: string }>;
  not_available_note: string;
};

export type MandateTemplates = {
  templates: Array<{
    id: string;
    label: string;
    description: string;
    params: Array<Record<string, unknown>>;
  }>;
  max_chars: number;
  note: string;
};

/** POST /v1/agents/:id/pause — the response that must not be summarised away. */
export type PauseResult = {
  agent_id: string;
  status: string;
  /**
   * False. It is still sent, and still read, because the field is the answer
   * to a question an owner is right to ask — and because it was TRUE until the
   * engine stopped filtering armed guards on `a.status = 'active'`. A field
   * that quietly disappeared on the day the answer changed would leave every
   * older client rendering the absence of a warning as a reassurance.
   */
  protection_stops?: boolean;
  /** The levels that keep being checked through the pause, by symbol. */
  guards_still_watched?: string[];
  protection_note?: string;
  keeps?: string;
  /** What the pause actually stops: new decisions. */
  stops?: string;
  /** Sent by resume: the same levels, which were never suspended. */
  protection_unchanged?: string[];
  seat?: string;
  note?: string | null;
};

export type RiskResult = {
  agent_id: string;
  risk_profile: Record<string, unknown>;
  changed: string[];
  removed: string[];
  removed_note: string | null;
  applies_from: string;
  applies_note: string;
  risk_profile_unrecognised?: string[];
  risk_profile_note?: string;
  risk_profile_ambiguous?: string[];
  risk_profile_ambiguous_note?: string;
};
