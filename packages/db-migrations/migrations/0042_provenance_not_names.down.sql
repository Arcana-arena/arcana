-- 0042_provenance_not_names.down.sql
--
-- Dropping the column takes the classification with it, which is the honest
-- reversal: the backfill in the up migration is a judgement about rows, and
-- there is nowhere else to keep it once the column is gone.
--
-- The triggers go first. A DROP COLUMN would fire them otherwise, and a trigger
-- that refuses the change would refuse the removal.

DROP TRIGGER IF EXISTS creators_provenance_immutable ON creators;
DROP TRIGGER IF EXISTS agents_provenance_immutable ON agents;
DROP FUNCTION IF EXISTS provenance_is_immutable();

DROP INDEX IF EXISTS idx_agents_provenance;
DROP INDEX IF EXISTS idx_creators_provenance;

ALTER TABLE creators DROP CONSTRAINT IF EXISTS creators_provenance_known;
ALTER TABLE agents   DROP CONSTRAINT IF EXISTS agents_provenance_known;

ALTER TABLE creators DROP COLUMN IF EXISTS provenance;
ALTER TABLE agents   DROP COLUMN IF EXISTS provenance;
