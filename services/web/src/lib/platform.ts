/**
 * The platform-wide reads the landing page is built on.
 *
 * These shapes are written from the responses, and every one of them is a count
 * or a sum the database performed. Nothing here is added up in the browser.
 */

export type PlatformStats = {
  agents: { total: number; active: number; retired: number; draft: number };
  creators: { total: number };
  decisions: { total: number; last_24h: number; trades: number; last_at: string | null };
  executions: { settled: number; blocked: number; reverted: number; total: number };
  volume: { usdg: number; basis: string; legs_without_usdg: number };
  chain: {
    id: number;
    last_block_seen: number | null;
    last_block_at: string | null;
    blocks_seen: number;
    note: string;
  };
  seasons: { total: number; running: number; upcoming: number; ended: number };
  as_of: string;
};

export type DecidedByBlock = {
  category: 'agent' | 'protective_exit' | 'protective_held_back' | 'protective_other' | 'unattributed';
  label: string;
  note: string;
  decider: string | null;
  reason_code: string | null;
};

export type RecentDecision = {
  ts: string;
  agent_id: string;
  agent_name: string;
  version: number | null;
  action: string;
  symbol: string | null;
  quantity: number | null;
  decider: string | null;
  reason_code: string | null;
  decided_by: DecidedByBlock;
  tx_hash: string | null;
  execution_status: string | null;
};

export type RecentExecution = {
  ts: string;
  agent_id: string;
  agent_name: string;
  version: number | null;
  action: string;
  symbol: string | null;
  status: string;
  refusal_code: string | null;
  quantity: number | null;
  notional_usdg: number | null;
  price_usdg: number | null;
  slippage_bps: number | null;
  tx_hash: string | null;
  block_number: number | null;
  blocks_since: number | null;
  gas_used: number | null;
  gas_cost_usd: number | null;
  decided_by: DecidedByBlock | null;
};

export type Feed<T> = { limit: number; items: T[]; as_of: string };
