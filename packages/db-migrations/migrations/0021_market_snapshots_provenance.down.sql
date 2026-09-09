-- 0021_market_snapshots_provenance.down.sql
DROP INDEX IF EXISTS idx_market_snapshots_source_trading_date;
DROP INDEX IF EXISTS idx_market_snapshots_source_tick;
ALTER TABLE market_snapshots DROP CONSTRAINT IF EXISTS market_snapshots_ingest_mode_check;
ALTER TABLE market_snapshots
  DROP COLUMN IF EXISTS fetched_at,
  DROP COLUMN IF EXISTS trading_date,
  DROP COLUMN IF EXISTS ingest_mode,
  DROP COLUMN IF EXISTS source;
