-- 0025_market_snapshots_market_return.up.sql
-- Stores the equal-weighted market return per tick, so it is computed once
-- rather than on every cold read.
--
-- THE PROBLEM THIS SOLVES, measured rather than assumed. MarketIndexService
-- rebuilt the whole index on every cache miss by making ONE HTTP ROUND TRIP PER
-- SNAPSHOT, over every snapshot ever recorded. On the production host:
--
--     260 snapshots   ->    556 ms   (Autopsy cold 553 ms, warm 16 ms)
--   2,190 snapshots   ->  4,175 ms   (a 4-hour cadence, one year)
--   8,760 snapshots   -> 14,269 ms   (an hourly cadence, one year)
--
-- Parallelising the fetches was tried first and is NOT the answer: at 8,760 it
-- gave 9,957 ms at concurrency 8 and no further improvement at 16, 32 or 64.
-- The bottleneck is server-side throughput — one object read per request — not
-- round-trip latency. The only real fix is to stop making the requests.
--
-- WHY A COLUMN AND NOT A CACHE. Snapshots are immutable by construction
-- (content_hash, never rewritten), so a return computed from two of them can
-- never go stale. It is a pure function of data that cannot change. That makes
-- it a derived fact worth storing, not a cache needing invalidation.
--
-- WHO COMPUTES IT — this matters more than where it is stored. It is still
-- MarketIndexService, and only MarketIndexService. The service fills this
-- column lazily for rows that are NULL and reads it back thereafter. Nothing
-- else writes it. market-data does NOT compute it at ingest, deliberately:
-- that would create a second definition of "what the market did", which is the
-- exact thing MarketIndexService was extracted to prevent.
--
-- NULLABLE, and nullable forever. NULL means "not computed yet", which is the
-- normal state of a freshly ingested snapshot and of every row that existed
-- before this migration. It is not an error, and the service treats it as work
-- to do rather than as a value.
--
-- DOUBLE PRECISION, NOT NUMERIC. The value is produced as a float64 and
-- compared against float64s. double precision round-trips exactly; NUMERIC
-- would round on the way in and change results in the last digits, which is
-- precisely what the before/after comparison for this change had to rule out.
--
-- SCOPED BY SOURCE, inherited from the code. The return is measured against the
-- previous tick FROM THE SAME SOURCE. A simulator price and a vendor price are
-- two unrelated worlds and the gap between them is not a return.

ALTER TABLE market_snapshots
  ADD COLUMN IF NOT EXISTS market_return DOUBLE PRECISION;

COMMENT ON COLUMN market_snapshots.market_return IS
  'Equal-weighted mean of per-symbol returns since the previous tick FROM THE '
  'SAME SOURCE. NULL means not yet computed. Written lazily by '
  'MarketIndexService, which remains the only definition of the market index; '
  'market-data does not compute it, so there is never a second answer.';

-- The service asks for "rows still needing a return", ordered the way it walks
-- them. A partial index keeps that lookup cheap as the table grows, and costs
-- nothing once every row is filled — which is the steady state.
CREATE INDEX IF NOT EXISTS idx_market_snapshots_pending_return
  ON market_snapshots (source, tick_time)
  WHERE market_return IS NULL;
