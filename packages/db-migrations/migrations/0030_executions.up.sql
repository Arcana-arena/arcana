-- 0030_executions.up.sql
-- Phase 8b: what actually happened on chain, as distinct from what was decided.
--
-- Until now a decision WAS the outcome. applyIntent() settled the trade against
-- snapshot prices in memory, so the recorded position was arithmetic on a
-- number the platform chose, and a trade that could not settle was written down
-- as a hold. That is defensible for virtual capital and indefensible once a
-- transaction is broadcast: a swap can be signed, paid for, mined, and revert.
-- Gas is gone, nothing moved, and "hold" is not what happened.
--
-- So execution becomes its own record, written from the CHAIN rather than from
-- intent. Every column here is something that can only be known after the fact.

CREATE TABLE IF NOT EXISTS executions (
  id             BIGSERIAL PRIMARY KEY,
  agent_id       UUID        NOT NULL REFERENCES agents(id),
  decision_id    BIGINT,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What was asked for.
  intent_action  VARCHAR(10) NOT NULL,
  symbol         VARCHAR(20) NOT NULL,
  token_in       TEXT        NOT NULL,
  token_out      TEXT        NOT NULL,
  amount_in      NUMERIC(40,0) NOT NULL,

  -- What was expected, at the moment of asking. quoted_out comes from an
  -- eth_call of the SAME calldata against live pool state, so the comparison
  -- below is quote-vs-fill rather than model-vs-fill.
  quoted_out     NUMERIC(40,0),
  min_out        NUMERIC(40,0),

  -- What happened. NULL means not known yet, which is a third state and not a
  -- zero: a transaction that has not been mined has moved nothing SO FAR.
  filled_out     NUMERIC(40,0),
  slippage_bps   NUMERIC(12,4),

  tx_hash        TEXT,
  block_number   BIGINT,
  gas_used       BIGINT,
  gas_price_wei  NUMERIC(40,0),
  gas_cost_wei   NUMERIC(40,0),

  -- signed | broadcast | mined | reverted | unresolved | refused | quote_failed
  --
  -- 'reverted' and 'unresolved' are the two this table exists for. A reverted
  -- swap cost gas and moved nothing. An unresolved one is neither a success nor
  -- a non-event: the transaction is out there, and recording it as either would
  -- be a guess written into an append-only log.
  status         VARCHAR(20) NOT NULL,
  refusal_code   TEXT,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_executions_agent_ts ON executions (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_executions_decision ON executions (decision_id);
CREATE INDEX IF NOT EXISTS idx_executions_unresolved ON executions (status) WHERE status = 'unresolved';

COMMENT ON TABLE executions IS
  'One row per attempt to move real funds. Written from chain reads, never from '
  'intent. A decision says what the agent chose; this says what the chain did '
  'with it, including the cases where the answer is "nothing" or "not yet".';

COMMENT ON COLUMN executions.filled_out IS
  'Measured as the balance delta of token_out across the transaction, not decoded '
  'from the router return value. The balance is what the agent can actually spend '
  'next tick; a return value is what the contract said it did.';

COMMENT ON COLUMN executions.status IS
  'reverted = mined and failed: gas paid, nothing moved. unresolved = broadcast '
  'and not mined within the wait: outcome genuinely unknown, and neither success '
  'nor non-event may be assumed.';
