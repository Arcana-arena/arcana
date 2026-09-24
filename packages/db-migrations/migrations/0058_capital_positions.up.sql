-- 0058_capital_positions.up.sql
-- ARCANA CAPITAL, architecture.md §17.5: what an agent owes and what backs it.
--
-- WRITTEN BY THE POSITION GUARD, READ BY THE AGENT PAGE, AND NOTHING ACTS ON IT.
-- Day 5 of §17.7 is "seeing the number has to precede moving it": a deleverage
-- driven by a health factor nobody has looked at is a liquidation with extra
-- steps. So the reader exists before any path that could borrow or repay.
--
-- ONE ROW PER READ OF A NON-EMPTY POSITION, plus one closing row with zeros when
-- a position that existed is gone. An agent that has never borrowed writes
-- nothing, so this table costs nothing until ARCANA CAPITAL is used.
--
-- TWO HEALTH FACTORS, because docs/go-no-go-lending.md condition 3 requires
-- both. `health_factor` is Morpho's own — the oracle price, the number
-- liquidation is decided on. `health_factor_worst` uses the lower of the oracle
-- and the Uniswap pool price, because the NVDA feed runs 24/5 and over a
-- weekend the oracle holds Friday's print while the token keeps trading. A
-- position that looks safe on the oracle and is not on the pool is exactly the
-- one that gets liquidated at Monday's open.
--
-- NULL HEALTH FACTOR MEANS NO DEBT, not an unknown one. With nothing borrowed
-- there is nothing to liquidate, and a large number standing in for infinity
-- would be read as a measurement by anything that sorts or averages it.

CREATE TABLE capital_positions (
  id                     BIGSERIAL PRIMARY KEY,
  agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_id              VARCHAR(66) NOT NULL,
  wallet                 VARCHAR(42) NOT NULL,
  collateral_symbol      VARCHAR(16) NOT NULL,
  -- Whole units. Converted once from base units by the writer, which is the
  -- only place decimals are known; see docs/capital.md.
  collateral_qty         NUMERIC(38, 18) NOT NULL,
  collateral_value_usdg  NUMERIC(38, 6)  NOT NULL,
  debt_usdg              NUMERIC(38, 6)  NOT NULL,
  lltv                   NUMERIC(8, 6)   NOT NULL,
  oracle_price_usdg      NUMERIC(38, 6)  NOT NULL,
  pool_price_usdg        NUMERIC(38, 6),
  health_factor          NUMERIC(20, 6),
  health_factor_worst    NUMERIC(20, 6),
  liquidation_price_usdg NUMERIC(38, 6),
  -- Age of each Chainlink feed behind the oracle, in seconds, and the token's
  -- advisory pause flag. The oracle checks neither; this is where they show.
  base_feed_age_s        INTEGER,
  quote_feed_age_s       INTEGER,
  oracle_paused          BOOLEAN,
  CONSTRAINT capital_positions_nonneg_ck
    CHECK (collateral_qty >= 0 AND debt_usdg >= 0 AND collateral_value_usdg >= 0)
);

CREATE INDEX idx_capital_positions_agent_ts ON capital_positions (agent_id, ts DESC);
