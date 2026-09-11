-- 0039_subscriber_guards.up.sql
-- Protective levels for a subscriber's positions.
--
-- WHY THIS COULD NOT WAIT. A buyer paying for an agent that sets stop losses
-- will reasonably assume their own position is protected too. If it is not,
-- that is the same hole as the unprotected position made visible in 0037 —
-- except in somebody else's wallet, with somebody else's money, and with the
-- buyer having paid precisely for the behaviour they are not getting.

ALTER TABLE position_guards
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id);

-- ONE ARMED GUARD PER POSITION, and a subscription's position is a different
-- position from the agent's even when it is the same symbol.
--
-- The old index was unique on (agent_id, symbol) while armed. Left alone it
-- would let the first subscriber's guard block every other subscriber's, and
-- the agent's block all of them — one buyer's stop loss silently absent
-- because another buyer got there first.
DROP INDEX IF EXISTS uq_position_guards_armed;

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_guards_armed_agent
  ON position_guards (agent_id, symbol)
  WHERE status = 'armed' AND subscription_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_guards_armed_subscription
  ON position_guards (subscription_id, symbol)
  WHERE status = 'armed' AND subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_position_guards_subscription
  ON position_guards (subscription_id) WHERE subscription_id IS NOT NULL;

COMMENT ON COLUMN position_guards.subscription_id IS
  'Whose position this guard watches. NULL means the creator''s wallet. A '
  'subscriber''s guard is armed from the price THEIR fill got, not the '
  'creator''s: the same decision reaches several wallets at several prices, and '
  'a level measured against somebody else''s entry is a level measured against '
  'a number that never happened to you.';

-- ============================================================================
-- WHAT A SUBSCRIBER'S PROTECTIVE EXIT DOES NOT WRITE.
-- ============================================================================
--
-- It writes NO ROW IN `decisions`, and that is the opposite of the rule for the
-- creator's wallet, so it is worth stating why.
--
-- `decisions` is the agent's competition record. A stop firing in one buyer's
-- wallet, at a price only that wallet crossed, is not something the agent
-- decided — and writing it there would put N rows into an agent's trading
-- history for an event that happened in other people's accounts. An agent with
-- fifty subscribers would look fifty times busier than it traded.
--
-- What decided is the LEVEL, and the level already has a row: position_guards
-- carries triggered_at, triggered_side and triggered_price. The execution
-- carries subscription_id and on_behalf_of. Between them the record says whose
-- money moved and what decided, which is the whole requirement — it simply says
-- it in the guard rather than in the competition log.
ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS guard_id BIGINT REFERENCES position_guards(id);

COMMENT ON COLUMN executions.guard_id IS
  'The protective level that caused this execution, when one did. For a '
  'subscriber''s exit this is what names the decider, because such an exit '
  'writes no row in `decisions`: it is not something the agent decided.';
