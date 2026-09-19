-- 0054_own_cadence.up.sql
-- How often an agent decides belongs to its owner, not to the competition it
-- happens to be in.
--
-- WHAT WAS ACTUALLY IN THE WAY. The four-hour policy floor had already been
-- retired from the binary (cmd/cadence's header records why: it assumed
-- deciding is trading, and the measured rate was one trade in five decisions).
-- What remained was structural: the interval lived in a systemd unit, one per
-- COMPETITION, so every participant shared one clock chosen by an operator. An
-- owner whose strategy is hourly and an owner whose strategy is weekly were
-- both given four hours, and neither was asked.
--
-- So the interval moves onto the agent, where the strategy is.
--
-- 14400 IS THE DEFAULT BECAUSE IT IS WHAT THEY ALREADY RUN AT. Every existing
-- row keeps the cadence it has been keeping, so this migration changes no
-- agent's behaviour on its own — the owner changing the number does.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS cadence_seconds INT NOT NULL DEFAULT 14400;

-- SIXTY SECONDS, AND IT IS NOT A POLICY. A pool snapshot is identified by
-- 'pool-' + UTC 'YYYYMMDDTHHMMZ' — MINUTE resolution — and
-- decisions.market_snapshot_ref is a foreign key into market_snapshots. Two
-- decisions inside one minute are two decisions claiming the same immutable
-- description of the market, and the record stops being able to say what the
-- agent saw. The constraint is in the schema rather than only in the binary
-- because it is a fact about these rows, and a second writer would otherwise
-- have to remember it.
--
-- The upper bound is a month: past that the agent is not running a cadence, it
-- is parked, and `retire` says that properly.
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_cadence_seconds_ck;
ALTER TABLE agents
  ADD CONSTRAINT agents_cadence_seconds_ck
  CHECK (cadence_seconds >= 60 AND cadence_seconds <= 2592000);

COMMENT ON COLUMN agents.cadence_seconds IS
  'How often this agent is asked to decide, in seconds, chosen by its owner. '
  'The pacer (decision-engine cmd/pace) measures the age of the agent''s LAST '
  'RECORDED DECISION against it, so the schedule cannot drift from the record. '
  'Floor 60s: snapshot refs have minute resolution and decisions reference them '
  'by id. Fees are the owner''s to spend — what bounds the platform''s exposure '
  'is the signer''s per-agent daily signature cap and the engine''s per-agent '
  'daily token budget, both of which are measured directly.';

-- Read by the pacer on every run, once a minute, for every active agent.
CREATE INDEX IF NOT EXISTS idx_agents_active_cadence
  ON agents (cadence_seconds) WHERE status = 'active';
