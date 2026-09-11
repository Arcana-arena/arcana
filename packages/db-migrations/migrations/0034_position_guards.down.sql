-- 0034_position_guards.down.sql
--
-- The comment on decisions.decider is restored to what 0026 wrote, rather than
-- dropped: a column losing its documentation is not the same as a column going
-- back to what it was.
COMMENT ON COLUMN decisions.decider IS NULL;

DROP TABLE IF EXISTS guard_heartbeat;
DROP TABLE IF EXISTS agent_execution_leases;
DROP TABLE IF EXISTS position_guards;
