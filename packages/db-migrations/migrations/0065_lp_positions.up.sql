-- 0065_lp_positions.up.sql
-- ARCANA LIQUIDITY PROVISION (architecture.md §21), position registry.
--
-- THE REGISTRY IS A CACHE OF CHAIN STATE, NOT A LEDGER. The chain is the
-- source of truth: every lp_positions row can be rebuilt by re-reading the
-- NonfungiblePositionManager, and nothing in this schema moves money. The
-- service that writes it (services/arbitrage) is read-only: it signs nothing,
-- holds no keys and has no code path that sends a transaction.
--
-- STANDALONE AND NAMESPACED. No §7 core table is altered and nothing in the
-- core schema reads these rows. A future liquidity reputation must be its own
-- model; it does not enter the ARCANA Score or Agent Credit.

-- ONE ROW PER POSITION NFT, kept current by the LP sync loop. Unlike
-- arbitrage_opportunities this is NOT append-only: it is a registry of what
-- exists now, so the state columns are overwritten on every sync and the table
-- grows with positions owned, not with time. discovered_at survives the
-- updates so "how long has this been watched" stays answerable.
CREATE TABLE lp_positions (
  id               BIGSERIAL PRIMARY KEY,
  -- The position manager and tokenId together are the NFT's identity.
  position_manager VARCHAR(64) NOT NULL,
  token_id         VARCHAR(78) NOT NULL,
  -- The agent whose wallet owns it (agent_wallets.agent_id) and that wallet,
  -- lowercased, exactly as the chain reports it.
  agent_id         UUID NOT NULL,
  wallet           VARCHAR(64) NOT NULL,
  -- Resolved through the v3 factory at sync time.
  pool             VARCHAR(64) NOT NULL,
  token0           VARCHAR(64) NOT NULL,
  token1           VARCHAR(64) NOT NULL,
  fee_tier         INTEGER NOT NULL,
  tick_lower       INTEGER NOT NULL,
  tick_upper       INTEGER NOT NULL,
  -- Raw chain integers as decimal strings: uint128 for the liquidity and the
  -- stored tokensOwed (40 digits is the uint128 bound), up to uint256 for the
  -- amounts the position holds at the current price.
  liquidity        VARCHAR(40) NOT NULL,
  tokens_owed0     VARCHAR(40) NOT NULL,
  tokens_owed1     VARCHAR(40) NOT NULL,
  current_tick     INTEGER,
  in_range         BOOLEAN,
  amount0          VARCHAR(78),
  amount1          VARCHAR(78),
  -- The read-only verdict the loop acts on: hold | rebalance | empty.
  recommendation   VARCHAR(12),
  -- open = owned by an agent wallet; closed = burned or no longer owned.
  status           VARCHAR(12) NOT NULL DEFAULT 'open',
  discovered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at   TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  provenance       VARCHAR(20) NOT NULL DEFAULT 'live',
  CONSTRAINT lp_positions_token_id_ck CHECK (token_id ~ '^[0-9]{1,78}$'),
  CONSTRAINT lp_positions_wallet_ck CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT lp_positions_pool_ck CHECK (pool ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT lp_positions_liquidity_ck CHECK (liquidity ~ '^[0-9]{1,40}$'),
  CONSTRAINT lp_positions_recommendation_ck CHECK (recommendation IS NULL OR recommendation IN ('hold', 'rebalance', 'empty')),
  CONSTRAINT lp_positions_status_ck CHECK (status IN ('open', 'closed')),
  CONSTRAINT lp_positions_closed_ck CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT lp_positions_provenance_ck CHECK (provenance IN ('live', 'verification')),
  CONSTRAINT lp_positions_identity_uq UNIQUE (position_manager, token_id)
);

CREATE INDEX idx_lp_positions_agent ON lp_positions (agent_id, status);
CREATE INDEX idx_lp_positions_status ON lp_positions (status, last_synced_at DESC);

-- THE LOOP'S OUTPUT. When a sync finds a position that is out of range or
-- empty, it writes the action it would take as a `proposed` row with the
-- numbers attached. NOTHING EXECUTES THESE ROWS TODAY: this service cannot
-- sign, and no service calls the signer's lp_* shapes yet. A row stands until
-- the recommendation that produced it stops holding — then it is superseded
-- (superseded_at set) and, if the new verdict is still rebalance/empty, a new
-- row is written. At most one proposal per position is outstanding.
CREATE TABLE lp_position_actions (
  id               BIGSERIAL PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  position_manager VARCHAR(64) NOT NULL,
  token_id         VARCHAR(78) NOT NULL,
  agent_id         UUID NOT NULL,
  -- The verdict this action was proposed under. rebalance = collect, decrease
  -- all liquidity, burn, then mint a fresh range; empty = collect, then burn.
  -- The detail column names the exact signer intents.
  recommendation   VARCHAR(12) NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'proposed',
  superseded_at    TIMESTAMPTZ,
  -- The numbers: new ticks and amounts for a rebalance, owed tokens for a
  -- close. JSONB because this is a plan, not a fact with a settled shape.
  detail           JSONB NOT NULL,
  CONSTRAINT lp_position_actions_recommendation_ck CHECK (recommendation IN ('rebalance', 'empty')),
  CONSTRAINT lp_position_actions_status_ck CHECK (status IN ('proposed', 'superseded')),
  CONSTRAINT lp_position_actions_superseded_ck CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

CREATE INDEX idx_lp_position_actions_status ON lp_position_actions (status, ts DESC);
CREATE INDEX idx_lp_position_actions_position ON lp_position_actions (position_manager, token_id);

-- ONE ROW, THE LOOP'S HEARTBEAT. Same rule as the scanner's: a loop that ran
-- and found nothing keeps this row fresh; one that died does not. It also
-- carries discovery_block, the highest block whose Transfer logs have been
-- read, so a restart resumes discovery instead of rescanning the chain.
CREATE TABLE lp_sync_heartbeat (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  positions        INTEGER NOT NULL DEFAULT 0,
  actions_proposed INTEGER NOT NULL DEFAULT 0,
  discovery_block  BIGINT,
  error            TEXT
);
