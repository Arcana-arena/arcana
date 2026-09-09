-- 0022_score_snapshots_season_id.down.sql
-- NOTE: reverting re-introduces the silent-drop bug described in the up
-- migration. Any agent scored in two seasons will lose one of the two rows on
-- the next batch run.
DROP INDEX IF EXISTS idx_score_snapshots_agent_season_ts;
ALTER TABLE score_snapshots DROP CONSTRAINT IF EXISTS score_snapshots_pkey;
ALTER TABLE score_snapshots DROP COLUMN IF EXISTS season_id;
ALTER TABLE score_snapshots ADD PRIMARY KEY (agent_id, ts);
