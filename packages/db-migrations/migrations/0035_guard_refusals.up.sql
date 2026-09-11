-- 0035_guard_refusals.up.sql
-- A blocked protective exit is ONE fact, not one fact per scan.
--
-- WHAT HAPPENED. The position guard scans every fifteen seconds. When a level
-- was crossed and the cost meter refused the exit, ExecuteProtective recorded
-- that refusal as a decision — correctly, once. Then it did it again fifteen
-- seconds later, and again, for as long as the condition held: fifty-seven
-- identical rows in fifteen minutes, at a rate of 240 an hour.
--
-- Each row was true. Together they were a lie of a different kind: `decisions`
-- is what every read model counts to decide whether an agent has competed, and
-- inflating it with one condition sampled repeatedly makes participation,
-- Autopsy and the Passport all describe an agent that was busy when it was
-- stuck.
--
-- The fix is to remember that the refusal was already recorded, which is a
-- property of the GUARD rather than of the decision log.
ALTER TABLE position_guards
  -- When this guard last had a crossing it could not act on, and why.
  ADD COLUMN IF NOT EXISTS last_refusal_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_refusal_reason VARCHAR(40),
  ADD COLUMN IF NOT EXISTS last_refusal_decision_id BIGINT;

COMMENT ON COLUMN position_guards.last_refusal_at IS
  'When a crossing on this guard was last refused — by the owner cost budget, '
  'or by anything else that stops the exit. A refusal is recorded as a decision '
  'ONCE and then remembered here, because the guard rescans every fifteen '
  'seconds and a condition that persists is one fact, not 240 an hour.';

-- Finding guards that are crossed and stuck, which is what the watchdog alarms
-- on: an owner whose stop loss is being held back needs to know today.
CREATE INDEX IF NOT EXISTS idx_position_guards_refused
  ON position_guards (last_refusal_at DESC) WHERE last_refusal_at IS NOT NULL;
