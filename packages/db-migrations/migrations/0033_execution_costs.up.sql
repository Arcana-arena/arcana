-- 0033_execution_costs.up.sql
-- What a trade COST, recorded rather than embedded in a price nobody can decompose.
--
-- Gas has been recorded since 0030. The pool fee has not, and it is the larger
-- of the two on any pool wider than 5 bp: a 30 bp round trip costs 0.6% of the
-- amount traded, against roughly 0.8% for gas on a $12 book and far less than
-- that on a real one.
--
-- It was invisible because it is taken INSIDE the swap. `quoted_out` and
-- `filled_out` are both already net of it, so no amount of comparing them
-- reveals it. A cost meter measuring spend against capital had no way to see
-- the fee at all, which is half of what it is supposed to measure.
--
-- HOW THE FEE IS DERIVED, and how exact that is.
--
-- Uniswap V3 takes the fee from the INPUT before swapping. For an exact-input
-- swap the whole input is consumed, so:
--
--     fee = amount_in * fee_tier / 1_000_000
--
-- Both terms come from the transaction that was actually sent and confirmed:
-- amount_in is the amount field of the calldata, fee_tier is the fee field of
-- the same calldata, and the fee tier is decodable from the transaction on
-- chain rather than looked up in a table at analysis time. That distinction
-- matters: a lookup would silently produce the wrong number for a transaction
-- built before a fee tier changed.
--
-- It is EXACT up to per-step integer rounding inside the pool. V3 charges the
-- fee per swap step, and each step rounds up by at most one unit of the input
-- token; a swap crossing k initialised ticks can therefore differ from the
-- formula by at most k base units. On a 6-decimal token that is a fraction of a
-- cent, and the direction is known: the formula UNDER-states the fee, never
-- over-states it.
--
-- The alternative -- reading feeGrowthGlobal before and after and multiplying
-- by liquidity -- is exact to the wei and needs two archive reads per swap
-- against a chain whose public endpoints refuse archive requests. Recorded here
-- is the number that can be had reliably, with its error bounded and its
-- direction named.

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS pool_fee_units NUMERIC(40,0),
  ADD COLUMN IF NOT EXISTS pool_fee_usd   NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS gas_cost_usd   NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS eth_usd        NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS fee_tier       INTEGER;

COMMENT ON COLUMN executions.pool_fee_units IS
  'Fee paid to the pool, in base units of token_in, derived as '
  'amount_in * fee_tier / 1e6 from the calldata actually sent. NULL means no '
  'swap executed -- a refusal, a revert, or an approval -- which is different '
  'from a swap that happened to pay zero.';

COMMENT ON COLUMN executions.eth_usd IS
  'The ETH price used to convert gas to dollars, read from this chain''s '
  'Chainlink feed at execution time. Stored so the conversion can be audited '
  'later rather than re-derived from a price that has since moved.';

COMMENT ON COLUMN executions.fee_tier IS
  'The pool fee tier in hundredths of a bip, as it appeared in the calldata. '
  'Recorded rather than looked up: a tier read from the allowlist at analysis '
  'time would misdescribe any transaction built before that entry changed.';

-- The cost meter sums these per agent over a trailing window.
CREATE INDEX IF NOT EXISTS idx_executions_agent_cost
  ON executions (agent_id, ts)
  WHERE gas_cost_usd IS NOT NULL OR pool_fee_usd IS NOT NULL;
