-- 0004_create_portfolios.up.sql
-- ARCANA portfolios + portfolio_snapshots, per docs/architecture.md §7.
-- portfolio_snapshots is converted to a hypertable in a later migration.

CREATE TABLE portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  season_id UUID NOT NULL,
  initial_capital NUMERIC(20,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE portfolio_snapshots (
  portfolio_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  holdings JSONB NOT NULL,
  nav NUMERIC(20,2) NOT NULL,
  cash NUMERIC(20,2) NOT NULL,
  PRIMARY KEY (portfolio_id, ts)
);
