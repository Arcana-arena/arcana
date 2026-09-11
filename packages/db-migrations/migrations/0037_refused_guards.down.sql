DROP INDEX IF EXISTS idx_position_guards_refused;
ALTER TABLE position_guards DROP COLUMN IF EXISTS min_acceptable_pct;
ALTER TABLE position_guards DROP CONSTRAINT IF EXISTS position_guards_armed_has_a_level;
ALTER TABLE position_guards ADD CONSTRAINT position_guards_has_a_level
  CHECK (take_profit IS NOT NULL OR stop_loss IS NOT NULL);
