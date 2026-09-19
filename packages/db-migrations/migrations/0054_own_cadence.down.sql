-- 0054_own_cadence.down.sql
--
-- Dropping the column loses every owner's choice, and there is nowhere else it
-- is written down. Reverting this means every agent goes back to the interval of
-- whatever competition unit happens to name it — which for agents created after
-- this migration is no interval at all, so they stop deciding entirely until a
-- per-competition cadence unit covers them. Read that sentence before running
-- this on a database with live agents.

DROP INDEX IF EXISTS idx_agents_active_cadence;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_cadence_seconds_ck;
ALTER TABLE agents DROP COLUMN IF EXISTS cadence_seconds;
