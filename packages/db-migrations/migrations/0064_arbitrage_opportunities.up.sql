-- 0064_arbitrage_opportunities.up.sql
-- ARCANA ARBITRAGE (architecture.md §20), market-intelligence first slice.
--
-- THE SERVICE IS READ-ONLY. It records what the scanner saw, never what it did:
-- nothing here is signed, and no row in this table moves money. The same-chain
-- go/no-go (docs/go-no-go-arbitrage.md, 2026-10-18) returned NO — one liquid
-- venue — so today's rows are expected to be `indicative`; the table is the
-- foundation Phase 2/3 build on.
--
-- STANDALONE AND NAMESPACED. No §7 core table is altered, and nothing in the
-- core schema reads these rows. A future arbitrage reputation must be its own
-- model; it does not enter the ARCANA Score or Agent Credit.

-- ONE ROW PER TOKEN PER SCAN. Append-only: a scan never edits an earlier
-- scan's reading, so the history is the record of what the scanner measured.
CREATE TABLE arbitrage_opportunities (
  id                 BIGSERIAL PRIMARY KEY,
  ts                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol             VARCHAR(20) NOT NULL,
  -- Venue ids from the config (e.g. uniswap-v3, uniswap-v3-referee, uniswap-v2-*).
  venue_buy          VARCHAR(80) NOT NULL,
  venue_sell         VARCHAR(80) NOT NULL,
  -- Fee-adjusted executable quotes (the venue's fee is already inside).
  buy_price          NUMERIC(38,12) NOT NULL,
  sell_price         NUMERIC(38,12) NOT NULL,
  -- Spread net of both venue fees.
  gross_spread_bps   NUMERIC(12,4) NOT NULL,
  -- Net after gas and the impact buffer. Executable iff >= min_net_profit_bps.
  est_net_profit_bps NUMERIC(12,4) NOT NULL,
  fee_buy_bps        INTEGER NOT NULL,
  fee_sell_bps       INTEGER NOT NULL,
  gas_bps            NUMERIC(12,4) NOT NULL,
  impact_buffer_bps  INTEGER NOT NULL,
  reference_size_usd NUMERIC(20,2) NOT NULL,
  -- Raw uint128 in-range liquidity, decimal string, audit-only (impact is not
  -- yet derived from it — see config/robinhood-arbitrage.json impact_buffer_note).
  liquidity_buy      VARCHAR(40),
  liquidity_sell     VARCHAR(40),
  status             VARCHAR(12) NOT NULL,
  provenance         VARCHAR(20) NOT NULL DEFAULT 'live',
  CONSTRAINT arbitrage_opportunities_symbol_ck CHECK (symbol ~ '^[A-Z0-9]{1,20}$'),
  CONSTRAINT arbitrage_opportunities_venue_buy_ck CHECK (length(venue_buy) > 0),
  CONSTRAINT arbitrage_opportunities_venue_sell_ck CHECK (length(venue_sell) > 0),
  CONSTRAINT arbitrage_opportunities_price_ck CHECK (buy_price > 0 AND sell_price > 0),
  CONSTRAINT arbitrage_opportunities_fee_ck CHECK (fee_buy_bps >= 0 AND fee_sell_bps >= 0),
  CONSTRAINT arbitrage_opportunities_status_ck CHECK (status IN ('indicative', 'executable')),
  CONSTRAINT arbitrage_opportunities_provenance_ck CHECK (provenance IN ('live', 'verification'))
);

CREATE INDEX idx_arbitrage_opportunities_ts ON arbitrage_opportunities (ts DESC);

-- ONE ROW, THE SCANNER'S HEARTBEAT. A scanner that ran and found nothing is
-- distinguishable from one that died: the former keeps this row fresh.
CREATE TABLE arbitrage_scan_heartbeat (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunities INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
