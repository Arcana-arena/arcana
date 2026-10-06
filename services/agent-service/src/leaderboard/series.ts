import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Return, drawdown, age and a sparkline — for every agent in a season at once.
 *
 * WHY THIS IS NOT FOUR MORE COLUMNS ON /v1/leaderboard. The leaderboard is a
 * cheap read: one row per agent from a score snapshot, and several surfaces use
 * it that need nothing more. These four figures come from the NAV series — a
 * per-agent scan of portfolio_snapshots — and welding them on would make every
 * caller pay for a table only the leaderboard page draws. Two reads, asked in
 * parallel, joined by agent_id.
 *
 * AND WHY IT IS NOT COMPUTED IN THE BROWSER. Return and maximum drawdown are
 * derived from a running peak over an ordered series. Doing that per row in a
 * page means the definition of "drawdown" lives in the frontend, where nothing
 * tests it and where the next surface will implement it slightly differently.
 * It is one window function here.
 *
 * WHAT EACH FIGURE IS, precisely:
 *
 *   return_pct          (last NAV − first NAV) / first NAV, inside this season
 *                       only. Not since inception: a score belongs to a season,
 *                       and so does the return printed beside it.
 *   max_drawdown_pct    the largest fall from a running peak, over the same
 *                       window. The peak is the highest NAV SEEN SO FAR, not
 *                       the highest overall, because a drawdown is measured
 *                       from what the agent had, not from what it later got.
 *   age_days            days between the agent's first and last snapshot in the
 *                       season. Time competing, not time since it was created —
 *                       an agent made in March and started in May has competed
 *                       for the shorter of the two.
 *   series              a sparkline that keeps its extremes. See below.
 */

export type SeriesRow = {
  agent_id: string;
  first_nav: number | null;
  last_nav: number | null;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  first_ts: string | null;
  last_ts: string | null;
  age_days: number | null;
  points: number;
  series: Array<{ ts: string; nav: number; agg: 'min' | 'max' }>;
};

const round = (v: number | null, dp: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

@Injectable()
export class LeaderboardSeriesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async forSeason(seasonId: string, buckets: number) {
    // The two reads share nothing but their input, so they run together.
    const statsP = this.db.query(
      `
      WITH snaps AS (
        SELECT p.agent_id, ps.ts, ps.nav::float8 AS nav
          FROM portfolio_snapshots ps
          JOIN portfolios p ON p.id = ps.portfolio_id
          JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
         WHERE p.season_id = $1 AND ps.nav IS NOT NULL
      ),
      w AS (
        SELECT agent_id, ts, nav,
               -- THE RUNNING PEAK, not the overall maximum. A drawdown is a
               -- fall from what the agent had at the time; measuring it against
               -- a high it only reached later would invent losses it never took.
               max(nav) OVER (PARTITION BY agent_id ORDER BY ts
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak
          FROM snaps
      )
      -- first() and last() are TimescaleDB's "value at the earliest/latest ts".
      -- They replace a whole-partition window that carried the same two
      -- numbers on every row and cost more than the rest of the query.
      SELECT agent_id::text,
             first(nav, ts) AS first_nav,
             last(nav, ts)  AS last_nav,
             min(ts) AS first_ts,
             max(ts) AS last_ts,
             count(*)::int AS points,
             max(CASE WHEN peak > 0 THEN (peak - nav) / peak ELSE 0 END) AS max_dd_frac
        FROM w
       GROUP BY agent_id`,
      [seasonId],
    );

    // THE SPARKLINE KEEPS ITS EXTREMES.
    //
    // Averaging a bucket is what makes a chart lie: the deepest point of a
    // drawdown is exactly the value an average removes, and a sparkline drawn
    // from means is a calmer line than the one that happened. Each bucket
    // contributes its minimum and its maximum, each at its own timestamp, in
    // time order — the same rule the per-agent series endpoint follows.
    //
    // ONE ROW PER EXTREME. Matching on the value instead returned every row
    // tied for it, and an agent holding cash is tied with itself on every
    // tick: measured 2026-10-06, 74,000 points and 2.2 MB for a column of
    // sparklines 130 pixels wide. The earliest row at each extreme is kept, and
    // a flat bucket is one point, not two.
    const seriesP = this.db.query(
      `
      WITH snaps AS (
        SELECT p.agent_id, ps.ts, ps.nav::float8 AS nav
          FROM portfolio_snapshots ps
          JOIN portfolios p ON p.id = ps.portfolio_id
          JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
         WHERE p.season_id = $1 AND ps.nav IS NOT NULL
      ),
      bucketed AS (
        SELECT agent_id, ts, nav,
               ntile($2) OVER (PARTITION BY agent_id ORDER BY ts) AS bucket
          FROM snaps
      ),
      ranked AS (
        SELECT agent_id, ts, nav,
               row_number() OVER (PARTITION BY agent_id, bucket ORDER BY nav ASC, ts ASC)  AS lo_rank,
               row_number() OVER (PARTITION BY agent_id, bucket ORDER BY nav DESC, ts ASC) AS hi_rank
          FROM bucketed
      )
      SELECT agent_id::text, ts, nav,
             CASE WHEN lo_rank = 1 THEN 'min' ELSE 'max' END AS agg
        FROM ranked
       WHERE lo_rank = 1 OR hi_rank = 1
       ORDER BY agent_id, ts`,
      [seasonId, buckets],
    );
    const [stats, series] = await Promise.all([statsP, seriesP]);

    const byAgent = new Map<string, SeriesRow['series']>();
    for (const r of series as Array<{ agent_id: string; ts: Date; nav: number; agg: 'min' | 'max' }>) {
      if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
      byAgent.get(r.agent_id)!.push({ ts: new Date(r.ts).toISOString(), nav: r.nav, agg: r.agg });
    }

    const items: SeriesRow[] = (stats as Array<Record<string, unknown>>).map((r) => {
      const first = r.first_nav === null ? null : Number(r.first_nav);
      const last = r.last_nav === null ? null : Number(r.last_nav);
      const firstTs = r.first_ts ? new Date(r.first_ts as string) : null;
      const lastTs = r.last_ts ? new Date(r.last_ts as string) : null;
      return {
        agent_id: r.agent_id as string,
        first_nav: round(first, 2),
        last_nav: round(last, 2),
        // Null rather than zero when the first NAV is missing or zero: a return
        // of 0% and "we cannot compute a return" are different statements.
        return_pct: first && last !== null && first !== 0 ? round(((last - first) / first) * 100, 2) : null,
        max_drawdown_pct: r.max_dd_frac === null ? null : round(Number(r.max_dd_frac) * 100, 2),
        first_ts: firstTs ? firstTs.toISOString() : null,
        last_ts: lastTs ? lastTs.toISOString() : null,
        age_days:
          firstTs && lastTs ? round((lastTs.getTime() - firstTs.getTime()) / 86400000, 1) : null,
        points: Number(r.points ?? 0),
        series: byAgent.get(r.agent_id as string) ?? [],
      };
    });

    return {
      season_id: seasonId,
      buckets,
      basis:
        'Return and drawdown are measured inside this season only, from portfolio snapshots. ' +
        'The drawdown is the largest fall from a running peak, and age is time competing rather ' +
        'than time since the agent was created.',
      items,
      as_of: new Date().toISOString(),
    };
  }
}
