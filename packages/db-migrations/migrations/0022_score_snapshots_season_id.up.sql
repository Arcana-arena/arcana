-- 0022_score_snapshots_season_id.up.sql
-- Binds every score to the season it was earned in.
--
-- WHY NOW. Season 1 ran on simulator prices; Season 2 runs on real vendor
-- prices. Without this column both land in one series per agent, and every
-- consumer reads them as one career: the leaderboard's "latest score", the
-- Passport's peak, the history chart. Comparing a score earned against
-- generated prices with one earned against the market -- as though they
-- measured the same thing -- is precisely the failure the archive was meant to
-- prevent, and archiving alone does not prevent it.
--
-- IT ALSO FIXES A LIVE BUG. `ActiveScorableAgents` returns one row per (agent,
-- portfolio), i.e. one per season. The moment an agent holds a portfolio in two
-- seasons, the batch writes two rows in the same run with the same
-- (agent_id, ts) -- and the old `ON CONFLICT (agent_id, ts) DO NOTHING`
-- SILENTLY DROPPED the second. Season 2 would have triggered it on day one:
-- the season would simply never score, with no error anywhere. The primary key
-- has to carry season_id for the same reason the column does.
--
-- TimescaleDB: score_snapshots is a hypertable partitioned on `ts`. A unique
-- index must include the partitioning column, and (agent_id, season_id, ts)
-- does, so this is a supported shape.
--
-- BACKFILL. Existing rows predate the column. Each is attributed through the
-- agent's portfolio, which is exactly how the Passport was inferring it (by
-- participation window) -- only now it is recorded rather than re-derived on
-- every read.
--
-- The NOT NULL is asserted only AFTER the backfill, and the migration FAILS if
-- any row could not be attributed. That failure is intended, in the same spirit
-- as 0019: an unattributable score is one nobody can say the provenance of, and
-- guessing a season for it would put an invented fact in the evidence table.

ALTER TABLE score_snapshots ADD COLUMN season_id UUID;

-- Attribute each score through the agent's portfolio. Unambiguous while an
-- agent competes in one season at a time; an agent in two seasons at once has
-- no single answer, so those rows are deliberately left NULL and caught below.
UPDATE score_snapshots s
   SET season_id = p.season_id
  FROM (
    SELECT agent_id, MIN(season_id::text)::uuid AS season_id
    FROM portfolios
    GROUP BY agent_id
    HAVING COUNT(DISTINCT season_id) = 1
  ) p
 WHERE p.agent_id = s.agent_id
   AND s.season_id IS NULL;

DO $$
DECLARE orphans BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphans FROM score_snapshots WHERE season_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'score_snapshots: % row(s) could not be attributed to a season. '
      'Resolve them by hand before migrating -- an invented season on a score '
      'is a fact nobody can check. (Cause: the agent has no portfolio, or '
      'portfolios in more than one season.)', orphans;
  END IF;
END $$;

ALTER TABLE score_snapshots ALTER COLUMN season_id SET NOT NULL;

ALTER TABLE score_snapshots DROP CONSTRAINT score_snapshots_pkey;
ALTER TABLE score_snapshots ADD PRIMARY KEY (agent_id, season_id, ts);

-- Per-season reads: the leaderboard's season filter, the Passport's per-season
-- record, and the history chart all scope by (agent, season) over time.
CREATE INDEX idx_score_snapshots_agent_season_ts
  ON score_snapshots(agent_id, season_id, ts DESC);
