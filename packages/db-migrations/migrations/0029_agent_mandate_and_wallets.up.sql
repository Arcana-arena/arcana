-- 0029_agent_mandate_and_wallets.up.sql
-- Phase 12: users create their own agents, and each agent gets a wallet.
--
-- Three things, all of which exist because the answer to "who supplied this
-- text, and who holds this key" has to be answerable from the row itself.

-- --------------------------------------------------------------------------
-- 1. How a mandate was produced.
-- --------------------------------------------------------------------------
--
-- 0026 added agents.mandate and said agents are built from a PARAMETERISED
-- TEMPLATE, not a free prompt. The column alone cannot hold that promise: a
-- TEXT column accepts anything, and six months from now nobody can tell a
-- rendered template from a paragraph somebody pasted.
--
-- So the two halves are recorded separately. `mandate` stays the rendered
-- text the engine reads -- unchanged, so nothing downstream has to care -- and
-- these two say where it came from.
--
-- mandate_params holds ONLY values drawn from enumerations and numeric ranges
-- the template declares. No free string is accepted from a user anywhere in
-- this path. That is a stronger property than the engine's 600-character cap
-- and its fencing, which remain as a second line rather than the only one:
-- the cap limits how much user text reaches the model, this makes it none.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS mandate_template VARCHAR(64),
  ADD COLUMN IF NOT EXISTS mandate_params   JSONB;

COMMENT ON COLUMN agents.mandate_template IS
  'Id of the template that rendered agents.mandate. NULL for agents predating '
  'phase 12 and for the seeded built-ins, which have no mandate at all.';

COMMENT ON COLUMN agents.mandate_params IS
  'The parameters the owner chose, as validated against the template''s '
  'declared enumerations and numeric ranges. Never free text: no user-supplied '
  'string reaches the model prompt by this path.';

-- --------------------------------------------------------------------------
-- 2. Agent wallets.
-- --------------------------------------------------------------------------
--
-- WHAT IS NOT HERE: any private key, and any seed. This table holds an
-- ADDRESS and a description of who can sign for it. Key material lives with
-- the signer, in a file the service user cannot read (see docs/signer.md);
-- putting it here would hand it to every service with a database connection
-- and copy it into every backup archive.
--
-- key_custody is the load-bearing column, and it has exactly two states:
--
--   platform_only  ARCANA derived this key and nobody has ever asked for it.
--                  The platform is the only party that can sign.
--
--   shared         The key exists in at least one other place. Either the
--                  owner exported it, or the owner imported a key they already
--                  had. There is NO WAY BACK from shared: an exported key
--                  cannot be un-exported, and pretending otherwise would be
--                  the kind of comfortable fiction that makes reconciliation
--                  bugs unexplainable.
--
-- The distinction is not paperwork. Under `shared`, the owner can move funds
-- from outside the platform at any moment, including while a position is open,
-- and ARCANA finds out by reading the chain rather than by being told. Code
-- that assumes its own database knows the balance is wrong for these agents,
-- so the column exists to make that assumption impossible to make by accident.
CREATE TABLE IF NOT EXISTS agent_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  address           VARCHAR(42) NOT NULL UNIQUE,
  -- 'derived' = from the platform master seed; 'imported' = supplied by the owner.
  provenance        VARCHAR(16) NOT NULL,
  -- 'platform_only' | 'shared'. See above; shared is one-way.
  key_custody       VARCHAR(16) NOT NULL DEFAULT 'platform_only',
  -- NO DERIVATION INDEX, and its absence is the design rather than an
  -- omission. The signer derives a wallet with HKDF keyed on the AGENT ID
  -- itself (keys.go: info = 'arcana/agent-wallet/v1/<agent id>'), so the key
  -- is a pure function of a value already in this row's primary relationship.
  -- An index would be a second, redundant source of truth for the same key,
  -- and the failure mode of two sources of truth for a key is losing funds.
  exported_at       TIMESTAMPTZ,
  imported_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_wallets_provenance_ck
    CHECK (provenance IN ('derived', 'imported')),
  CONSTRAINT agent_wallets_custody_ck
    CHECK (key_custody IN ('platform_only', 'shared')),
  -- An imported key is shared from the moment it arrives, by definition: the
  -- owner had it first. Enforced here rather than trusted to the application,
  -- because this is the invariant every custody decision downstream rests on.
  CONSTRAINT agent_wallets_imported_is_shared_ck
    CHECK (provenance <> 'imported' OR key_custody = 'shared'),
  -- Likewise: if a key was ever exported, custody is shared. There is no
  -- combination of columns that says "exported but ARCANA alone can sign".
  CONSTRAINT agent_wallets_exported_is_shared_ck
    CHECK (exported_at IS NULL OR key_custody = 'shared')
);

CREATE INDEX IF NOT EXISTS idx_agent_wallets_custody
  ON agent_wallets (key_custody) WHERE key_custody = 'shared';

COMMENT ON TABLE agent_wallets IS
  'One wallet per agent. ADDRESSES ONLY -- no private key and no seed is stored '
  'in this database, by design; key material lives in a file the service user '
  'cannot read. key_custody=shared means the owner also holds the key and can '
  'move funds without going through ARCANA, including mid-position.';

-- --------------------------------------------------------------------------
-- 3. Custody drift.
-- --------------------------------------------------------------------------
--
-- The consequence of `shared`, written down as a table because it WILL happen
-- and the alternative is discovering it as a stack trace.
--
-- An owner holding their own key can move funds at any time. The first the
-- platform knows of it is that the chain disagrees with the portfolio it
-- recorded. That is not corruption and not an attack -- it is the owner using
-- a key that is legitimately theirs -- so it must not be handled by crashing,
-- and it must not be handled by silently overwriting the record either.
--
-- Every divergence is recorded here with both numbers, and the portfolio is
-- reconciled TO THE CHAIN, because the chain is what the next trade will
-- actually execute against.
CREATE TABLE IF NOT EXISTS custody_drift (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the token was; NULL means the chain's native asset (gas).
  token_address VARCHAR(42),
  symbol        VARCHAR(32),
  -- Base units, as strings: these are uint256 and must not go through a float.
  expected      NUMERIC(78, 0) NOT NULL,
  observed      NUMERIC(78, 0) NOT NULL,
  -- observed - expected. Negative = funds left. Positive = funds arrived,
  -- which is equally a divergence and equally worth recording: an owner
  -- topping up their agent from outside is a normal thing to do.
  delta         NUMERIC(78, 0) NOT NULL,
  -- What the platform did about it. 'reconciled' = portfolio adjusted to the
  -- chain. 'halted' = the divergence left the agent unable to honour an open
  -- position and it was stood down instead of trading on a fiction.
  resolution    VARCHAR(24) NOT NULL,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_custody_drift_agent
  ON custody_drift (agent_id, detected_at DESC);

COMMENT ON TABLE custody_drift IS
  'Divergence between the portfolio ARCANA recorded and the balance the chain '
  'reports, for agents whose owner also holds the key. Expected to be non-empty: '
  'an owner moving their own money is not a fault. The chain always wins the '
  'reconciliation, because the chain is what the next trade executes against.';
