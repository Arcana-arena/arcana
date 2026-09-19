-- 0055_no_default_wait.up.sql
-- The platform's default cadence stops being a waiting period.
--
-- 0054 moved cadence onto the agent and defaulted it to 14400 — four hours —
-- because that is what every agent had been running at while the interval lived
-- in a competition's unit file. Keeping the number made the migration
-- behaviour-neutral, and that was the mistake: the four hours were never anyone's
-- choice, and defaulting to them meant a newly created, funded agent still sat
-- idle for up to four hours before it was asked anything. Its owner had chosen
-- nothing of the sort, and nothing in the product told them the number existed.
--
-- So the default becomes the FLOOR. An agent looks every minute from the moment
-- it is active, and what keeps it from trading is the market not moving beyond
-- its own rebalance band — which its decision log states — rather than a clock it
-- cannot see.
--
-- WHAT THIS DOES NOT CHANGE: the floor itself (60s, the snapshot ref's minute
-- resolution), the ceiling (a month), or an owner's ability to ask for patience.
-- Four hours is still a perfectly good cadence; it is now a choice on the row
-- instead of a habit in the platform.
ALTER TABLE agents ALTER COLUMN cadence_seconds SET DEFAULT 60;

-- --------------------------------------------------------------------------
-- Every active agent still on the platform's old default moves with it.
-- --------------------------------------------------------------------------
--
-- ONLY ROWS STILL HOLDING 14400, and only active ones. An owner who deliberately
-- asked for four hours would be indistinguishable here from one who was simply
-- given it — the column is an hour old, so today nobody has chosen it, and this
-- is the one moment where that is knowable. From now on 14400 means somebody
-- typed it, and no later migration may assume otherwise.
--
-- Drafts and retired agents are left alone: a draft is refused by the engine and
-- a retired agent has stood down, so a cadence on either is a number waiting for
-- a decision that is not coming.
UPDATE agents
   SET cadence_seconds = 60
 WHERE status = 'active'
   AND cadence_seconds = 14400;

COMMENT ON COLUMN agents.cadence_seconds IS
  'How often this agent is asked to decide, in seconds, chosen by its owner. '
  'Default 60 — the floor — because a platform default that made a funded agent '
  'wait was a wait nobody chose. The pacer (decision-engine cmd/pace) measures '
  'this against the age of the agent''s LAST RECORDED DECISION, so the schedule '
  'cannot drift from the record. Floor 60s: snapshot refs have minute resolution '
  'and decisions reference them by id. Ceiling one month: past that an agent is '
  'parked, and retire says so properly. Fees are the owner''s to spend — what '
  'bounds the platform is the signer''s per-agent daily signature cap and the '
  'engine''s per-agent daily token budget, both measured directly.';
