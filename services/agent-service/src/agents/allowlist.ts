import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The signer's allowlist, READ FROM THE SIGNER'S OWN FILE and not a copy.
 *
 * The signer refuses what this file does not; if this service kept its own list
 * of caps and tiers, an owner would save a mandate the signer then refuses and
 * find out on the first borrow. Read on every call: the file changes only by a
 * reviewed commit and a deploy, and a cached copy would outlive both.
 */
export type CreditTier = {
  tier: number;
  min_score: number;
  max_debt_usdg: string;
  min_scored_days?: number;
};

export type Allowlist = {
  tokens: Array<{ symbol: string }>;
  lending?: {
    enabled: boolean;
    markets: Array<{ id: string; name: string }>;
    limits: { max_borrow_per_tx_usdg: string; max_debt_per_agent_usdg: string };
    credit?: { enabled: boolean; tiers: CreditTier[] };
  };
};

export function readAllowlist(): Allowlist {
  const path = process.env.CAPITAL_ALLOWLIST_FILE
    || resolve(process.cwd(), '../signer/allowlist/robinhood-mainnet.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}
