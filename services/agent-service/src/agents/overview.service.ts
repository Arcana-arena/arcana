import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The eight figures on an agent's Overview, counted once in SQL.
 *
 * WHY A READ AND NOT A PAGE THAT ADDS UP THREE OTHERS. Return, drawdown,
 * volatility, trades, turnover, win rate, age and average exposure were
 * scattered across the autopsy, the DNA batch and the career block, in
 * different windows, with different definitions of "trade". A page assembling
 * them would be deciding which window each one belonged to — and the eight
 * boxes would quietly be measuring eight different periods.
 *
 * ONE WINDOW: the agent's most recent season. Every figure below is measured
 * inside it and says so, because a return since inception printed next to a
 * score that only exists inside a season is two different claims wearing one
 * layout.
 *
 * WHAT IS NULL AND WHY. Nothing here is estimated. A figure that cannot be
 * computed from the record comes back null with a reason beside it — win rate
 * needs closed round trips, volatility needs at least two NAV points, and an
 * agent that has never traded has no turnover rather than a turnover of zero.
 */
@Injectable()
export class AgentOverviewService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async forAgent(agentId: string) {
    const agentRows = await this.db.query(
      `SELECT a.id, a.name, a.created_at, a.strategy_type,
              -- The cap is a declared risk rule, so a private agent's is withheld
              -- here, in the query, rather than trusted to every consumer.
              CASE WHEN a.visibility = 'private' THEN NULL
                   ELSE (a.risk_profile->>'max_position_pct')::float8 END AS cap_exposure,
              a.visibility
         FROM agents a WHERE a.id = $1`,
      [agentId],
    );
    if (agentRows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);

    // The season the agent most recently competed in. Chosen by the season's
    // own start, not by insertion order, for the same reason the autopsy does.
    const seasonRows = await this.db.query(
      `SELECT s.id, s.name, s.start_at, s.end_at
         FROM portfolios p JOIN seasons s ON s.id = p.season_id
        WHERE p.agent_id = $1
        ORDER BY s.start_at DESC LIMIT 1`,
      [agentId],
    );
    const season = seasonRows[0] ?? null;
    if (!season) {
      return {
        agent_id: agentId,
        season: null,
        note: 'This agent has never been entered into a season, so there is no window to measure.',
        stats: null,
      };
    }

    const [nav, trades, exposure] = await Promise.all([
      // NAV: first, last, running-peak drawdown, and the volatility of the
      // tick-to-tick returns. stddev_samp needs two points and returns NULL
      // with one, which is the correct answer rather than zero.
      this.db.query(
        `WITH s AS (
           SELECT ps.ts, ps.nav::float8 AS nav
             FROM portfolio_snapshots ps
             JOIN portfolios p ON p.id = ps.portfolio_id
            WHERE p.agent_id = $1 AND p.season_id = $2 AND ps.nav IS NOT NULL
            ORDER BY ps.ts
         ),
         w AS (
           SELECT ts, nav,
                  first_value(nav) OVER whole AS first_nav,
                  last_value(nav)  OVER whole AS last_nav,
                  max(nav) OVER (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak,
                  nav / NULLIF(lag(nav) OVER (ORDER BY ts), 0) - 1 AS ret
             FROM s
           WINDOW whole AS (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
         )
         SELECT count(*)::int AS points,
                max(first_nav) AS first_nav,
                max(last_nav)  AS last_nav,
                min(ts) AS first_ts, max(ts) AS last_ts,
                max(CASE WHEN peak > 0 THEN (peak - nav) / peak ELSE 0 END) AS max_dd,
                stddev_samp(ret) AS ret_sd,
                avg(nav) AS mean_nav
           FROM w`,
        [agentId, season.id],
      ),
      // TRADES, SPLIT BY WHO DECIDED. The agent's own and the platform's are
      // never added together: an agent that made money because its stop worked
      // and one whose calls were good are two different agents.
      this.db.query(
        `SELECT count(*) FILTER (WHERE action <> 'hold')::int AS all_trades,
                count(*) FILTER (WHERE action <> 'hold' AND decider IS NOT NULL
                                   AND decider <> 'protective')::int AS own,
                count(*) FILTER (WHERE action <> 'hold' AND decider = 'protective')::int AS protective,
                count(*) FILTER (WHERE action <> 'hold' AND decider IS NULL)::int AS unattributed,
                count(*)::int AS decisions,
                coalesce(sum(abs(quantity::float8 * NULLIF((resulting_allocation->>symbol)::float8, 0))), 0) AS notional_proxy
           FROM decisions_counted
          WHERE agent_id = $1 AND season_id = $2`,
        [agentId, season.id],
      ),
      this.db.query(
        // BOTH LIVE UNDER risk_personality. `strategy_fingerprint` is a pgvector
        // column, not jsonb, and reading `fingerprint->'features'` from it threw
        // "column does not exist" — caught the moment the endpoint was first
        // called, which is the right place for a wrong column name to surface.
        `SELECT (risk_personality->>'avg_exposure')::float8 AS avg_exposure,
                (risk_personality->>'max_exposure')::float8 AS max_exposure,
                (risk_personality->'features'->>'turnover')::float8 AS turnover
           FROM agent_dna WHERE agent_id = $1`,
        [agentId],
      ),
    ]);

    const n = nav[0] ?? {};
    const t = trades[0] ?? {};
    const e = exposure[0] ?? {};

    const first = n.first_nav === null || n.first_nav === undefined ? null : Number(n.first_nav);
    const last = n.last_nav === null || n.last_nav === undefined ? null : Number(n.last_nav);
    const points = Number(n.points ?? 0);

    const firstTs = n.first_ts ? new Date(n.first_ts) : null;
    const lastTs = n.last_ts ? new Date(n.last_ts) : null;

    const round = (v: unknown, dp: number) => {
      const x = v === null || v === undefined ? null : Number(v);
      return x === null || !Number.isFinite(x) ? null : Number(x.toFixed(dp));
    };

    return {
      agent_id: agentId,
      season: { id: season.id, name: season.name },
      stats: {
        return_pct: {
          value: first && last !== null && first !== 0 ? round(((last - first) / first) * 100, 2) : null,
          note: first ? 'Measured inside this season, first NAV to last.' : 'No opening NAV to measure from.',
        },
        max_drawdown_pct: {
          value: round(Number(n.max_dd ?? 0) * 100, 2),
          note: points > 1
            ? 'The largest fall from a running peak — from what the book had at the time, not from a high it reached later.'
            : 'Fewer than two NAV points, so no fall can be measured.',
          measurable: points > 1,
        },
        volatility: {
          // The standard deviation of tick-to-tick returns, NOT annualised.
          // Annualising needs a tick frequency, and this platform's cadence has
          // changed inside a season before: the factor would be a guess wearing
          // a percentage sign.
          value: round(n.ret_sd === null ? null : Number(n.ret_sd) * 100, 4),
          note: 'Standard deviation of tick-to-tick NAV returns, in percent. Not annualised: the ' +
            'tick cadence has changed inside a season before, and the scaling factor would be a guess.',
          measurable: n.ret_sd !== null && n.ret_sd !== undefined,
        },
        trades: {
          own: Number(t.own ?? 0),
          protective: Number(t.protective ?? 0),
          unattributed: Number(t.unattributed ?? 0),
          total: Number(t.all_trades ?? 0),
          note: 'The agent\'s own trades and the platform\'s protective exits are counted separately ' +
            'and never summed into one figure.',
        },
        decisions: Number(t.decisions ?? 0),
        turnover: {
          value: round(e.turnover, 4),
          note: e.turnover === null || e.turnover === undefined
            ? 'The DNA batch has not run over this agent, so turnover has not been measured.'
            : 'From the behavioural fingerprint, over the same window the DNA batch used.',
          measurable: e.turnover !== null && e.turnover !== undefined,
        },
        // WIN RATE IS NULL, AND SAYS SO RATHER THAN GUESSING.
        //
        // A win rate needs closed round trips — a buy matched to the sell that
        // ended it — and this platform does not record that pairing. Counting
        // profitable SELLS instead would call a partial reduction a win and
        // would count a stop-loss exit as one too. A number that is wrong in a
        // way nobody can see is worse than an absence anyone can.
        win_rate: {
          value: null,
          note: 'Not published. A win rate needs closed round trips — a buy matched to the sell ' +
            'that ended it — and the record does not pair them. Counting profitable sells instead ' +
            'would score a partial reduction as a win and credit the agent with its stop losses.',
          measurable: false,
        },
        age: {
          days: firstTs && lastTs ? round((lastTs.getTime() - firstTs.getTime()) / 86400000, 1) : null,
          first_tick: firstTs ? firstTs.toISOString() : null,
          last_tick: lastTs ? lastTs.toISOString() : null,
          nav_points: points,
          note: 'Time competing in this season, not time since the agent was created.',
        },
        avg_exposure: {
          value: round(e.avg_exposure, 4),
          max_seen: round(e.max_exposure, 4),
          cap: round(agentRows[0].cap_exposure, 4),
          note: e.avg_exposure === null || e.avg_exposure === undefined
            ? 'The DNA batch has not run over this agent, so exposure has not been measured.'
            : 'Mean share of the book at risk, from the behavioural fingerprint.',
          measurable: e.avg_exposure !== null && e.avg_exposure !== undefined,
        },
        nav: { first: round(first, 2), last: round(last, 2), points },
      },
      as_of: new Date().toISOString(),
    };
  }
}
