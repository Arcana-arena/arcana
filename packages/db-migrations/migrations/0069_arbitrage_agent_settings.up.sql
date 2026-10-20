-- 0069_arbitrage_agent_settings.up.sql
-- ARBITRAGE IS OPT-IN, PER AGENT, BY ITS CREATOR.
--
-- Providing liquidity puts an agent's OWN funds into a pool, so it is not
-- something the platform switches on for everybody. The creator decides, per
-- agent, whether that agent may carry LP positions. Every agent that exists
-- today and every agent created later starts with the feature OFF: an ABSENT
-- ROW MEANS DISABLED, so "no row" and "enabled = false" say the same thing to
-- the loop and no backfill is ever needed.
--
-- WHAT DISABLING DOES, AND WHAT IT DELIBERATELY DOES NOT (the wind-down rule).
-- Disabled stops the two actions that CREATE exposure: opening a position, and
-- rebalancing a range the price has left (a rebalance removes the old position
-- and mints a new one). It does NOT stop harvesting accrued fees, and it does
-- not stop closing a position that has been emptied. Turning the feature off
-- must not strand funds in a pool or leave collected-able fees uncollected, and
-- neither of those two actions adds exposure or moves a range.
--
-- Standalone and namespaced: no §7 core table is altered. The creator reaches
-- these rows through agent-service (which checks ownership); the arbitrage
-- service writes them and its loop reads them to decide what it may propose.

CREATE TABLE arbitrage_agent_settings (
  agent_id    UUID PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  enabled_at  TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  -- The creator wallet that flipped it, for the audit trail. Not a foreign key:
  -- the writer is agent-service and its creators table is not this service's.
  updated_by  VARCHAR(64),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enabled means somebody switched it on, so there is a moment to point at.
  CONSTRAINT arbitrage_agent_settings_enabled_ck
    CHECK ((enabled AND enabled_at IS NOT NULL) OR (NOT enabled))
);

-- The loop asks one question — "who is enabled" — on every pass; a partial
-- index answers exactly that and stays small.
CREATE INDEX idx_arbitrage_agent_settings_enabled
  ON arbitrage_agent_settings (agent_id) WHERE enabled;
