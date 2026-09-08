-- 0019_decisions_snapshot_fk.down.sql
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_market_snapshot_ref_fkey;
