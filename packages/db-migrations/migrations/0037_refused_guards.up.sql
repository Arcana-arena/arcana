-- 0037_refused_guards.up.sql
-- A position whose owner asked for protection and did not get it.
--
-- WHAT HAPPENED. An agent's mandate said "get out if it drops 0.15%". It bought
-- MSFT, which trades in a 0.3% pool — a 0.6% round trip — so a 0.15% level is
-- crossed at the moment of entry by the arithmetic of the fee alone, and
-- resolveGuardLevels refused it. Correctly.
--
-- The refusal was recorded in the DECISION'S RATIONALE and nowhere else. So the
-- position sat open and unprotected, and the only way to know was to read the
-- prose of one decision row. An owner who wrote a stop loss into their prompt
-- would reasonably believe they had one.
--
-- Absence of protection has to be a STATE, not an implication: something that
-- can be queried, counted and alarmed on. So a refused guard gets a row, the
-- same as an armed one, and carries the level that WOULD have been accepted —
-- the actionable half, the way the cost meter names the capital that would fit
-- rather than only saying no.

-- The old constraint required a level on every row. A refused guard has none by
-- definition, so it is narrowed to the rows it was protecting: an ARMED guard
-- with no level would be a guard that can never fire, and that is still refused.
ALTER TABLE position_guards DROP CONSTRAINT IF EXISTS position_guards_has_a_level;
ALTER TABLE position_guards ADD CONSTRAINT position_guards_armed_has_a_level
  CHECK (status <> 'armed' OR take_profit IS NOT NULL OR stop_loss IS NOT NULL);

ALTER TABLE position_guards
  -- The smallest level this pool would have accepted, as a fraction. Stored so
  -- the answer to "then what should I have asked for" is in the row rather than
  -- in somebody's head.
  ADD COLUMN IF NOT EXISTS min_acceptable_pct NUMERIC(10,6);

COMMENT ON COLUMN position_guards.min_acceptable_pct IS
  'For a refused guard: the smallest protective level the pool this symbol '
  'trades in would accept, which is its round trip (2 x fee). A level at or '
  'inside it fires on the cost of its own entry.';

-- Finding unprotected positions, which is what the watchdog alarms on.
CREATE INDEX IF NOT EXISTS idx_position_guards_refused
  ON position_guards (agent_id, symbol) WHERE status = 'refused';
