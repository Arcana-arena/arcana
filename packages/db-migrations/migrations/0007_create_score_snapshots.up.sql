-- 0007_create_score_snapshots.up.sql
-- ARCANA score_snapshots table, per docs/architecture.md §7.
-- Converted to a hypertable in a later migration.

CREATE TABLE score_snapshots (
  agent_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  arcana_score NUMERIC(6,2) NOT NULL,
  performance_score NUMERIC(6,2),
  risk_score NUMERIC(6,2),
  strategy_score NUMERIC(6,2),
  regime_score NUMERIC(6,2),
  consistency_score NUMERIC(6,2),
  creator_score NUMERIC(6,2),
  longevity_score NUMERIC(6,2),
  PRIMARY KEY (agent_id, ts)
);
