-- 0066_lp_execution.down.sql
--
-- THIS REFUSES WHILE ANY ACTION CARRIES AN EXECUTION STATUS, and that is
-- deliberate: rolling back would have to rewrite history (executed → proposed?
-- superseded?) or delete it, and either turns a record of what happened into a
-- guess. Drop the rows explicitly, with whoever owns them watching, or leave
-- the migration in place.
DROP TABLE IF EXISTS lp_execution_steps;

ALTER TABLE lp_position_actions DROP COLUMN IF EXISTS error;
ALTER TABLE lp_position_actions DROP COLUMN IF EXISTS finished_at;
ALTER TABLE lp_position_actions DROP COLUMN IF EXISTS started_at;

ALTER TABLE lp_position_actions DROP CONSTRAINT lp_position_actions_status_ck;
ALTER TABLE lp_position_actions ADD CONSTRAINT lp_position_actions_status_ck
  CHECK (status IN ('proposed', 'superseded'));
