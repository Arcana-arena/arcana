-- 0063_credit_market.up.sql
-- AGENT CREDIT MARKETS, first step (architecture.md §19): indications of
-- interest. A capital provider reads the agents that have a capital record
-- and writes down what they would supply to one of them.
--
-- AN INDICATION IS NOT A LOAN AND NOT A PROMISE. Nothing here is signed by a
-- wallet beyond the sign-in, nothing is escrowed, and no service reads this
-- table to move a limit or a balance. It records interest so that the step
-- that does move money can be sized against something that was measured.
--
-- NONE OF IT ENTERS THE ARCANA SCORE OR THE CAPITAL REPUTATION. Neither the
-- scoring engine nor the position guard reads this table: interest in an agent
-- is not evidence about the agent.

-- ONE ROW PER INDICATION, KEPT WHEN IT ENDS. Changing the amount ends the open
-- row as 'replaced' and writes a new one; taking it back ends it as
-- 'withdrawn'. What a provider said and when is the record, so a row is never
-- edited into saying something else.
CREATE TABLE credit_market_indications (
  id               BIGSERIAL PRIMARY KEY,
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The signed-in wallet, lowercase. A provider is a wallet, not a creator:
  -- supplying capital does not require a creator profile.
  provider_wallet  VARCHAR(42) NOT NULL,
  -- Whole USDG the provider says they would supply to this agent.
  amount_usdg      NUMERIC(38, 6) NOT NULL,
  -- The yearly rate they would ask, in basis points. NULL: they named none.
  rate_bps         INTEGER,
  -- THE AGENT'S STANDING WHEN THIS WAS WRITTEN. Interest recorded while an
  -- agent was unrated is a different fact from interest in a rated one, and
  -- the reputation row it was read from may since have been replaced.
  agent_status_at  VARCHAR(12) NOT NULL,
  agent_score_at   INTEGER,
  agent_tier_at    INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL while the indication stands.
  ended_at         TIMESTAMPTZ,
  ended_how        VARCHAR(12),
  -- Whether a verification run wrote it (0042). Public totals count 'live'.
  provenance       VARCHAR(20) NOT NULL DEFAULT 'live',
  CONSTRAINT credit_market_indications_wallet_ck CHECK (provider_wallet ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT credit_market_indications_amount_ck CHECK (amount_usdg > 0),
  CONSTRAINT credit_market_indications_rate_ck CHECK (rate_bps IS NULL OR rate_bps BETWEEN 1 AND 10000),
  CONSTRAINT credit_market_indications_status_ck CHECK (agent_status_at IN ('no_record', 'unrated', 'rated')),
  -- Written so that no branch can evaluate to NULL, which a CHECK passes: the
  -- form `(rated AND score BETWEEN ..) OR (NOT rated AND score IS NULL)` lets a
  -- rated row with a NULL score through (0062).
  CONSTRAINT credit_market_indications_score_ck
    CHECK ((agent_status_at = 'rated') = (agent_score_at IS NOT NULL)
       AND (agent_score_at IS NULL OR agent_score_at BETWEEN 0 AND 100)),
  CONSTRAINT credit_market_indications_tier_ck CHECK (agent_tier_at >= 0),
  CONSTRAINT credit_market_indications_how_ck CHECK (ended_how IS NULL OR ended_how IN ('withdrawn', 'replaced')),
  CONSTRAINT credit_market_indications_ended_ck CHECK ((ended_at IS NULL) = (ended_how IS NULL)),
  CONSTRAINT credit_market_indications_provenance_known CHECK (provenance IN ('live', 'verification'))
);

-- ONE STANDING INDICATION PER PROVIDER PER AGENT. Without it a double-clicked
-- form would count one provider's interest twice.
CREATE UNIQUE INDEX credit_market_indications_open_uq
  ON credit_market_indications (agent_id, provider_wallet) WHERE ended_at IS NULL;

CREATE INDEX idx_credit_market_indications_wallet ON credit_market_indications (provider_wallet, created_at DESC);
