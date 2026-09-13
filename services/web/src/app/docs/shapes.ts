/** What GET /v1/docs/parameters returns — every figure the prose quotes. */
export type DocParams = {
  scoring: {
    weights: Array<{ key: string; weight: number; measures: boolean; note: string | null }>;
    weights_sum: number;
    weights_sum_note: string;
    strategy_note: string;
    strategy_is_a_term: false;
    min_decisions_to_rank: number;
    withheld_not_low: string;
    source: string;
  };
  season: {
    id: string;
    name: string;
    universe: string;
    start_at: string;
    end_at: string;
    access_tier: string;
    ruleset: Record<string, unknown>;
  } | null;
  season_note: string | null;
  symbols: string[];
  symbols_note: string;
  deciders: Array<{ decider: string; decisions: number }>;
  deciders_note: string;
  subscription:
    | {
        available: true;
        reason: null;
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
      }
    | { available: false; reason: string };
  as_of: string;
};
