ALTER TABLE executions DROP COLUMN IF EXISTS guard_id;
DROP INDEX IF EXISTS idx_position_guards_subscription;
DROP INDEX IF EXISTS uq_position_guards_armed_subscription;
DROP INDEX IF EXISTS uq_position_guards_armed_agent;
ALTER TABLE position_guards DROP COLUMN IF EXISTS subscription_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_guards_armed
  ON position_guards (agent_id, symbol) WHERE status = 'armed';
