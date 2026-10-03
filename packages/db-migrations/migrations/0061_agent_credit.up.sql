-- 0061_agent_credit.up.sql
-- AGENT CREDIT, architecture.md §18: the capital record as a reputation, and the
-- three things it is derived from.
--
-- EVERYTHING HERE IS WRITTEN BY THE POSITION GUARD AND RECOMPUTABLE. A cycle is
-- derived from capital_positions and capital_actions; a reputation row is
-- derived from the cycles and the liquidations. Only capital_liquidations holds
-- something that exists nowhere else in the database, and it exists on chain.
--
-- NONE OF IT ENTERS THE ARCANA SCORE (§17.3). The scoring engine reads none of
-- these tables.

-- A THIRD PARTY'S LIQUIDATION OF AN AGENT'S POSITION, read from Morpho's
-- Liquidate event. Until this table existed a liquidation left no ARCANA row at
-- all, and the capital record said "not detected yet" where a count belonged.
--
-- ONE ROW PER EVENT, keyed by where it is on chain, so a scan that reads the
-- same block range twice writes nothing the second time.
CREATE TABLE capital_liquidations (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  market_id     VARCHAR(66) NOT NULL,
  wallet        VARCHAR(42) NOT NULL,
  -- The block's own timestamp, not the time the scan found it.
  ts            TIMESTAMPTZ NOT NULL,
  block_number  BIGINT NOT NULL,
  tx_hash       VARCHAR(66) NOT NULL,
  log_index     INTEGER NOT NULL,
  liquidator    VARCHAR(42) NOT NULL,
  -- Whole units, converted once by the writer with the allowlist's decimals.
  repaid_usdg   NUMERIC(38, 6)  NOT NULL,
  seized_qty    NUMERIC(38, 18) NOT NULL,
  -- Debt the market wrote off because the collateral did not cover it.
  bad_debt_usdg NUMERIC(38, 6)  NOT NULL,
  CONSTRAINT capital_liquidations_event_uq UNIQUE (tx_hash, log_index),
  CONSTRAINT capital_liquidations_nonneg_ck CHECK (repaid_usdg >= 0 AND seized_qty >= 0 AND bad_debt_usdg >= 0)
);

CREATE INDEX idx_capital_liquidations_agent_ts ON capital_liquidations (agent_id, ts DESC);

-- WHERE THE EVENT SCAN HAS READ TO. One row per market. Advanced only after the
-- range's events are written, so a scan that dies half way reads the range
-- again rather than skipping it.
CREATE TABLE capital_scan_cursors (
  market_id    VARCHAR(66) PRIMARY KEY,
  block_number BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A LOAN AS A UNIT. A cycle opens at the first reading that finds debt where
-- there was none and closes at the first reading that finds none again.
--
-- usdg_days IS THE EVIDENCE, NOT THE ROW COUNT: the area under the debt curve.
-- Fourteen cycles of one USDG held for a minute are fourteen rows here and
-- almost nothing in usdg_days, which is what the reputation reads.
--
-- REBUILT, NOT APPENDED. The guard replaces an agent's cycles in a market from
-- the readings each time it recomputes, so a cycle row never disagrees with the
-- readings it came from.
CREATE TABLE capital_cycles (
  id                  BIGSERIAL PRIMARY KEY,
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  market_id           VARCHAR(66) NOT NULL,
  opened_at           TIMESTAMPTZ NOT NULL,
  -- NULL while the debt is still outstanding.
  closed_at           TIMESTAMPTZ,
  peak_debt_usdg      NUMERIC(38, 6) NOT NULL,
  usdg_days           NUMERIC(38, 6) NOT NULL,
  debt_seconds        BIGINT NOT NULL,
  -- Seconds the worst-case health factor spent under 1.5, the lowest floor a
  -- mandate may set.
  seconds_under_floor BIGINT NOT NULL,
  lowest_health_factor_worst NUMERIC(20, 6),
  borrowed_usdg       NUMERIC(38, 6) NOT NULL,
  repaid_usdg         NUMERIC(38, 6) NOT NULL,
  -- Repaid less borrowed, once closed. NULL while open: it is not known yet.
  interest_usdg       NUMERIC(38, 6),
  deleverage_steps    INTEGER NOT NULL,
  liquidations        INTEGER NOT NULL,
  -- repaid: the agent or its owner closed it. deleveraged: the guard had to
  -- act inside it. liquidated: a third party did. NULL while open.
  closed_how          VARCHAR(12),
  CONSTRAINT capital_cycles_open_uq UNIQUE (agent_id, market_id, opened_at),
  CONSTRAINT capital_cycles_how_ck
    CHECK (closed_how IS NULL OR closed_how IN ('repaid', 'deleveraged', 'liquidated')),
  CONSTRAINT capital_cycles_closed_ck CHECK ((closed_at IS NULL) = (closed_how IS NULL))
);

CREATE INDEX idx_capital_cycles_agent ON capital_cycles (agent_id, opened_at DESC);

-- CAPITAL REPUTATION, one row per change of standing.
--
-- score IS NULL WHEN THE AGENT IS UNRATED. Unrated is a state, not a zero: an
-- agent with a month of history and nothing wrong is not the same as one that
-- scored nothing, and a zero would be read as a measurement.
--
-- tier IS WHAT THE AGENT HOLDS, earned_tier WHAT ITS SCORE ALONE WOULD GIVE.
-- They differ when a gate holds the tier down — a recent liquidation, a stuck
-- deleverage, too short a scored track record — and held_because names which.
--
-- components AND inputs ARE THE WORKING, so the number on the Passport can be
-- recomputed by a reader rather than believed.
CREATE TABLE capital_reputation (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last time a recomputation arrived at this same standing. A row is
  -- written when the standing changes; a recomputation that changes nothing
  -- moves this instead, and refreshes the working below. A reputation whose
  -- confirmed_at is old has not been re-checked, and grants nothing.
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rated        BOOLEAN NOT NULL,
  unrated_why   TEXT,
  score         INTEGER,
  components    JSONB NOT NULL,
  inputs        JSONB NOT NULL,
  earned_tier   INTEGER NOT NULL,
  tier          INTEGER NOT NULL,
  held_because  VARCHAR(32),
  -- The debt limit the tier gave when this row was written, in whole USDG.
  -- Informational: the limit that is ENFORCED is read from the allowlist's tier
  -- table at the moment of the borrow.
  limit_usdg    NUMERIC(38, 6) NOT NULL,
  CONSTRAINT capital_reputation_score_ck
    CHECK ((rated AND score BETWEEN 0 AND 100) OR (NOT rated AND score IS NULL)),
  CONSTRAINT capital_reputation_tier_ck CHECK (tier >= 0 AND earned_tier >= tier)
);

CREATE INDEX idx_capital_reputation_agent_ts ON capital_reputation (agent_id, computed_at DESC);
