/**
 * The shapes the arbitrage service sends for liquidity provision, and the few
 * presentation helpers both surfaces share. TYPES AND FORMATTING ONLY: nothing
 * here decides or aggregates anything — the registry, the proposal queue and
 * the execution record are the service's answers.
 */
import { addr } from './format';

export type LPVenueToken = { symbol: string; address: string; decimals: number };
export type LPVenues = { quote_token: LPVenueToken; tokens: LPVenueToken[] };

export type LPPosition = {
  position_manager: string;
  token_id: string;
  agent_id: string;
  wallet: string;
  pool: string;
  token0: string;
  token1: string;
  fee_tier: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  tokens_owed0: string;
  tokens_owed1: string;
  current_tick: number | null;
  in_range: boolean | null;
  amount0: string | null;
  amount1: string | null;
  recommendation: string | null;
  status: string;
  provenance: string;
  discovered_at: string;
  last_synced_at: string | null;
  closed_at: string | null;
};

export type LPAction = {
  id: number;
  ts: string;
  token_id: string;
  agent_id: string;
  recommendation: string;
  status: string;
  superseded_at: string | null;
  detail: { intents?: string[] } | null;
};

export type LPStep = {
  id: number;
  ts: string;
  action_id: number;
  token_id: string;
  agent_id: string;
  recommendation: string;
  step: number;
  intent: string;
  status: string;
  tx_hash?: string;
  gas_used?: string;
  error?: string;
};

export type LPOpen = {
  id: number;
  ts: string;
  agent_id: string;
  symbol: string;
  pool: string;
  token_id?: string;
  tx_hash?: string;
  size_usd: number;
  status: string;
  error?: string;
};

export type REC = 'hold' | 'harvest' | 'rebalance' | 'empty';

export const REC_TONE: Record<string, 'neutral' | 'accent' | 'amber' | 'outline'> = {
  hold: 'neutral',
  harvest: 'accent',
  rebalance: 'amber',
  empty: 'outline',
};

/** Green for a receipt, amber for "on the wire", red for a refusal or revert. */
export const stepTone = (status: string): 'up' | 'am' | 'dn' =>
  status === 'mined' ? 'up' : status === 'broadcast' || status === 'unresolved' ? 'am' : 'dn';

/** "2dbc0eb1…" — an agent id is a UUID, not an address. */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}\u2026` : id);

/** A raw base-unit decimal string as a human number. Null stays null. */
export function units(raw: string | null | undefined, decimals: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** decimals;
}

/**
 * A symbol/decimals lookup for the configured tokens, falling back to the
 * shortened address — a face, not a guess about what the token is.
 */
export function tokenIndex(venues: LPVenues | null): (address: string) => LPVenueToken {
  const map = new Map<string, LPVenueToken>();
  if (venues) {
    for (const t of venues.tokens) map.set(t.address.toLowerCase(), t);
    map.set(venues.quote_token.address.toLowerCase(), venues.quote_token);
  }
  return (a: string) => map.get(a.toLowerCase()) ?? { symbol: addr(a), address: a, decimals: 18 };
}
