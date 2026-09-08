-- 0018_score_snapshots_nullable_arcana.down.sql
--
-- Restoring NOT NULL requires no unranked rows to exist: delete rows whose
-- arcana_score is NULL first, otherwise the constraint cannot be re-applied.
DELETE FROM score_snapshots WHERE arcana_score IS NULL;
ALTER TABLE score_snapshots ALTER COLUMN arcana_score SET NOT NULL;
