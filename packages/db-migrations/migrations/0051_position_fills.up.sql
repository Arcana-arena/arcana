-- 0051_position_fills.up.sql
-- Every fill, its price, and what it did to the position.
--
-- WHY. The entry price of a position was written down only where a protective
-- guard was armed, so a position opened without a stop had no cost basis and
-- every reader printed "not computable". And a position that closed left no
-- result: a finished trade's profit existed nowhere on a platform whose premise
-- is measuring what decisions produced. Neither was a display limitation; the
-- data was never stored.
--
-- So every fill that changes a book is recorded here when it happens — virtual
-- or on chain, the agent's own book or a subscriber's, the agent's decision or a
-- protective exit — with the position accounting done at write time (average
-- cost; see decision-engine/internal/store/fills.go, ApplyFill):
--
--   qty_before/after, avg_cost_before/after   the position around the fill
--   realized_pnl     sells only: (price - avg_cost_before) x quantity.
--                    NULL when the cost basis is unknown — never back-solved.
--   episode          a position's life from flat to flat, per book and symbol
--   gas_usd          what this fill (and its approval) paid in gas. NULL =
--                    unpriced, which is not free. 0 on a simulated fill.
--   pool_fee_usd     information only: the price is already net of it.
--
-- TWO BOOKS, NEVER MIXED. book='agent' is the agent's own portfolio in a
-- season; book='subscription' is one subscriber's wallet. A subscriber's fills
-- are theirs, and nothing that totals an agent or a creator may add them in.
--
-- APPEND-ONLY. A fill is an observation; nothing edits one. A row is deleted
-- only when the book it belongs to is deleted (a verification fixture's
-- portfolio or subscription, by cascade), or when it belongs to a verification
-- agent.

CREATE TABLE IF NOT EXISTS position_fills (
  id               BIGSERIAL PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL,
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  book             VARCHAR(12) NOT NULL CHECK (book IN ('agent', 'subscription')),
  portfolio_id     UUID REFERENCES portfolios(id) ON DELETE CASCADE,
  subscription_id  UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  decision_id      BIGINT,
  execution_id     BIGINT UNIQUE,
  symbol           VARCHAR(20) NOT NULL,
  side             VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity         NUMERIC(38,18) NOT NULL CHECK (quantity > 0),
  price            NUMERIC(38,12) NOT NULL CHECK (price > 0),
  notional         NUMERIC(38,12) NOT NULL,
  gas_usd          NUMERIC(20,8),
  pool_fee_usd     NUMERIC(20,8),
  source           VARCHAR(16) NOT NULL CHECK (source IN ('simulated', 'on_chain', 'reconstructed')),
  qty_before       NUMERIC(38,18) NOT NULL,
  avg_cost_before  NUMERIC(38,12),
  qty_after        NUMERIC(38,18) NOT NULL,
  avg_cost_after   NUMERIC(38,12),
  realized_pnl     NUMERIC(38,12),
  episode          INT NOT NULL CHECK (episode > 0),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((book = 'agent' AND portfolio_id IS NOT NULL AND subscription_id IS NULL)
      OR (book = 'subscription' AND subscription_id IS NOT NULL AND portfolio_id IS NULL)),
  CHECK (side = 'sell' OR realized_pnl IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_position_fills_portfolio ON position_fills (portfolio_id, symbol, ts DESC, id DESC)
  WHERE portfolio_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_position_fills_subscription ON position_fills (subscription_id, symbol, ts DESC, id DESC)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_position_fills_agent ON position_fills (agent_id, ts DESC);
-- One simulated fill per decision in the agent's book: a reconstruction run
-- twice must not record the same trade twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_fills_simulated_decision ON position_fills (decision_id)
  WHERE book = 'agent' AND execution_id IS NULL AND decision_id IS NOT NULL;

COMMENT ON TABLE position_fills IS
  'Every fill that changed a book, with its measured price and the average-cost accounting at write time. '
  'Append-only. book=agent is the agent''s own portfolio; book=subscription is a subscriber''s wallet and is '
  'never added into an agent''s or creator''s totals. source=reconstructed rows were rebuilt from executions '
  '(on chain) or from decisions priced at their market snapshot (virtual) when 0051 was introduced.';

CREATE OR REPLACE FUNCTION position_fill_is_append_only() RETURNS trigger AS $$
DECLARE
  fixture boolean;
  book_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'position fill % is an observation and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.provenance = 'verification') INTO fixture;
  IF fixture THEN
    RETURN OLD;
  END IF;
  -- Deleted by cascade from its book: the parent row is already gone.
  IF OLD.portfolio_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM portfolios p WHERE p.id = OLD.portfolio_id) INTO book_exists;
  ELSE
    SELECT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = OLD.subscription_id) INTO book_exists;
  END IF;
  IF book_exists THEN
    RAISE EXCEPTION 'position fill % belongs to a book that still exists and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS position_fills_append_only ON position_fills;
CREATE TRIGGER position_fills_append_only BEFORE UPDATE OR DELETE ON position_fills
  FOR EACH ROW EXECUTE FUNCTION position_fill_is_append_only();

-- A position's life from flat to flat, and what it made.
--   realized_pnl   sum over its sells; realized_unknown when any sell had no basis
--   gas_usd        sum over its fills; gas_unpriced when any fill was unpriced
--   net_pnl        realized minus gas, only when both are known
CREATE OR REPLACE VIEW position_episodes AS
SELECT f.agent_id, f.book, f.portfolio_id, f.subscription_id, f.symbol, f.episode,
       min(f.ts) AS opened_at,
       max(f.ts) FILTER (WHERE f.qty_after = 0) AS closed_at,
       (array_agg(f.qty_after ORDER BY f.ts DESC, f.id DESC))[1] AS qty_now,
       (array_agg(f.avg_cost_after ORDER BY f.ts DESC, f.id DESC))[1] AS avg_cost_now,
       coalesce(sum(f.quantity) FILTER (WHERE f.side = 'buy'), 0) AS bought_qty,
       coalesce(sum(f.notional) FILTER (WHERE f.side = 'buy'), 0) AS bought_notional,
       coalesce(sum(f.quantity) FILTER (WHERE f.side = 'sell'), 0) AS sold_qty,
       coalesce(sum(f.notional) FILTER (WHERE f.side = 'sell'), 0) AS sold_notional,
       sum(f.realized_pnl) AS realized_pnl,
       coalesce(bool_or(f.side = 'sell' AND f.realized_pnl IS NULL), false) AS realized_unknown,
       sum(f.gas_usd) AS gas_usd,
       coalesce(bool_or(f.gas_usd IS NULL), false) AS gas_unpriced,
       CASE WHEN coalesce(bool_or(f.side = 'sell' AND f.realized_pnl IS NULL), false)
              OR coalesce(bool_or(f.gas_usd IS NULL), false) THEN NULL
            ELSE coalesce(sum(f.realized_pnl), 0) - coalesce(sum(f.gas_usd), 0) END AS net_pnl,
       count(*)::int AS fills,
       bool_or(f.source = 'reconstructed') AS reconstructed
  FROM position_fills f
 GROUP BY f.agent_id, f.book, f.portfolio_id, f.subscription_id, f.symbol, f.episode;
