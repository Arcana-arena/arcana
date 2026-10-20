-- 0068_lp_opens.up.sql
-- POSITION OPENS — the one LP action the loop cannot propose, because it
-- creates the thing the loop observes.
--
-- A funded wallet becomes a position through `lpexec --open`: a reviewed plan
-- from GET /v1/arbitrage/lp/plan, an explicit per-open cap (LP_MAX_OPEN_USD),
-- the signer's lp_mint, the broadcast, and the receipt. This table is the audit
-- trail of that act — which agent, which pool, what size, which tokenId, under
-- which transaction, and under which plan.
--
-- Standalone and namespaced: no §7 core table is altered. The registry
-- (lp_positions) learns about the new position through the loop's own Transfer
-- log discovery, not through a second writer — this row is history, not state.

CREATE TABLE lp_opens (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id  UUID NOT NULL,
  symbol    VARCHAR(20) NOT NULL,
  pool      VARCHAR(64) NOT NULL,
  token_id  VARCHAR(78),
  tx_hash   VARCHAR(80),
  size_usd  NUMERIC(20,2) NOT NULL,
  status    VARCHAR(12) NOT NULL,
  error     TEXT,
  plan      JSONB NOT NULL,
  CONSTRAINT lp_opens_symbol_ck CHECK (symbol ~ '^[A-Z0-9]{1,20}$'),
  CONSTRAINT lp_opens_size_ck CHECK (size_usd > 0),
  CONSTRAINT lp_opens_status_ck CHECK (status IN ('executed', 'failed')),
  -- An executed open must name what it created and the transaction that did it.
  CONSTRAINT lp_opens_executed_ck CHECK ((status = 'executed') = (token_id IS NOT NULL AND tx_hash IS NOT NULL))
);

CREATE INDEX idx_lp_opens_agent ON lp_opens (agent_id, ts DESC);
