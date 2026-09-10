-- 0025_market_snapshots_market_return.down.sql
-- Drops the stored market return. Purely derived data: MarketIndexService can
-- recompute every value from the snapshots themselves, at the cost this
-- migration exists to remove (14.3 seconds per cold load at 8,760 snapshots).
DROP INDEX IF EXISTS idx_market_snapshots_pending_return;
ALTER TABLE market_snapshots DROP COLUMN IF EXISTS market_return;
