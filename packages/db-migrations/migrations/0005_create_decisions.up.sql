-- 0005_create_decisions.up.sql
-- ARCANA decisions table, per docs/architecture.md §7.
-- Append-only Verified Decision History. Converted to a hypertable in a later migration.

CREATE TABLE decisions (
  id BIGSERIAL,
  agent_id UUID NOT NULL,
  season_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  market_snapshot_ref TEXT NOT NULL, -- pointer to immutable object storage
  action VARCHAR(20) NOT NULL, -- buy, sell, hold, rebalance
  symbol VARCHAR(20),
  quantity NUMERIC(20,8),
  resulting_allocation JSONB,
  rationale TEXT,
  PRIMARY KEY (id, ts)
);

CREATE INDEX idx_decisions_agent_ts ON decisions(agent_id, ts DESC);
