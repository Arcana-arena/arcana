DROP INDEX IF EXISTS idx_position_guards_refused;
ALTER TABLE position_guards
  DROP COLUMN IF EXISTS last_refusal_at,
  DROP COLUMN IF EXISTS last_refusal_reason,
  DROP COLUMN IF EXISTS last_refusal_decision_id;
