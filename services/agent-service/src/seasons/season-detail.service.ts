import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MIN_DECISIONS, REGIME_WEIGHT_NOTE, SCORE_WEIGHTS, STRATEGY_NOTE } from '../common/ranking';

/**
 * The rules a season is run under, and the ticks it has actually produced.
 *
 * THE HARD PART HERE IS NOT THE QUERY — IT IS THE RULES THAT DO NOT EXIST.
 *
 * A season page wants seven rows: universe, score weights, minimum days live,
 * minimum decisions, minimum NAV to enter, agents per creator, and whether
 * evolving mid-season is allowed. This platform encodes three of them. The
 * other four are real product rules that nothing in the database or the code
 * enforces today.
 *
 * There were three ways to handle that and two of them are lies:
 *
 *   - print plausible numbers (14 days, 1,000 USDG, 3 agents) — that states a
 *     rule nobody is enforcing, and the first entrant who is not turned away
 *     learns the page was decoration;
 *   - omit the rows — a rules table with four rules missing reads as a rules
 *     table with four rules, and nobody can tell which are absent;
 *   - list every rule and mark the ones the platform does not encode, WITH the
 *     place the value would have to come from.
 *
 * The third is what this returns. `enforced: false` on a rule means the rule is
 * not applied — not that it is applied loosely — and `value: null` beside it
 * means there is no figure to state. A reader can see the shape of the
 * competition and also see exactly how much of it is currently automatic.
 *
 * EVERY VALUE THAT DOES EXIST NAMES ITS SOURCE, so the page cannot end up
 * quoting a constant that has since moved. The weights come from the same
 * SCORE_WEIGHTS the leaderboard publishes, which leaderboard-verify holds to
 * the Go engine.
 */

export type Rule = {
  key: string;
  label: string;
  /** The figure in force, or null when the platform holds none. */
  value: string | number | null;
  /** Where the value came from — a column, a constant, a service. */
  source: string | null;
  /**
   * `true`  — something refuses an entry or a score that breaks this.
   * `false` — the rule is described but nothing applies it.
   */
  enforced: boolean;
  note: string | null;
};

@Injectable()
export class SeasonDetailService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async rules(seasonId: string) {
    const rows = await this.db.query(
      `SELECT id::text, name, universe, start_at, end_at, ruleset, access_tier
         FROM seasons WHERE id = $1`,
      [seasonId],
    );
    if (rows.length === 0) throw new NotFoundException(`Season ${seasonId} not found`);
    const s = rows[0];
    const rs = (s.ruleset ?? {}) as Record<string, unknown>;

    const rules: Rule[] = [
      {
        key: 'universe',
        label: 'Universe',
        value: s.universe ?? null,
        source: 'seasons.universe',
        enforced: true,
        note: 'The asset universe a competing agent draws from.',
      },
      {
        key: 'initial_capital',
        label: 'Starting capital',
        value: (rs.initial_capital as number) ?? null,
        source: 'seasons.ruleset.initial_capital',
        enforced: rs.initial_capital !== undefined,
        note:
          rs.initial_capital === undefined
            ? 'This season carries no starting capital in its ruleset.'
            : 'Every portfolio opens at this NAV, so returns are comparable across entrants.',
      },
      {
        key: 'rebalance',
        label: 'Rebalance cadence',
        value: (rs.rebalance as string) ?? null,
        source: 'seasons.ruleset.rebalance',
        enforced: rs.rebalance !== undefined,
        note:
          rs.rebalance === undefined
            ? 'This season states no rebalance cadence, so the engine default applies.'
            : null,
      },
      {
        key: 'price_source',
        label: 'Price source',
        value: (rs.price_source as string) ?? null,
        source: 'seasons.ruleset.price_source',
        enforced: rs.price_source !== undefined,
        note:
          rs.price_source === undefined
            ? 'Not stated for this season.'
            : 'Where the prices every agent is scored against come from.',
      },
      {
        key: 'min_decisions_to_rank',
        label: 'Minimum decisions to be ranked',
        value: MIN_DECISIONS,
        source: 'scoring-engine minParticipationDecisions, mirrored in common/ranking.ts',
        enforced: true,
        note:
          'Below this the engine stores no score at all — not a low one. Protective exits do not ' +
          'count towards it: they are fired by an armed level, not chosen by the agent.',
      },
      {
        key: 'score_weights',
        label: 'Score weights',
        value: Object.entries(SCORE_WEIGHTS)
          .map(([k, v]) => `${k} ${v.toFixed(2)}`)
          .join(' · '),
        source: 'scoring-engine score.go, mirrored in common/ranking.ts',
        enforced: true,
        note: `${STRATEGY_NOTE} ${REGIME_WEIGHT_NOTE}`,
      },
      {
        key: 'access_tier',
        label: 'Entry tier',
        value: s.access_tier ?? 'standard',
        source: 'seasons.access_tier',
        enforced: true,
        note:
          s.access_tier === 'premium'
            ? 'A Premium Arena. Whether its $ARCA gate is actually reading a balance is a separate ' +
              'question — see the access block on the season itself, which answers it in three ' +
              'states rather than two.'
            : 'Open entry, subject to the platform-wide COMPETE gate.',
      },
      // ------------------------------------------------------------------
      // THE RULES THIS PLATFORM DOES NOT ENCODE. Listed, with nothing invented.
      // ------------------------------------------------------------------
      {
        key: 'min_days_live_to_rank',
        label: 'Minimum days live to be ranked',
        value: null,
        source: null,
        enforced: false,
        note:
          'Ranking is gated on the DECISION count only. No days-live threshold exists in the schema ' +
          'or in the scoring engine, so an agent that recorded enough decisions in one day is ranked.',
      },
      {
        key: 'min_nav_to_enter',
        label: 'Minimum NAV to enter',
        value: null,
        source: null,
        enforced: false,
        note:
          'No NAV floor is stored on a season or checked at registration. Entry is gated on the ' +
          '$ARCA COMPETE entitlement, not on the size of the portfolio.',
      },
      {
        key: 'agents_per_creator',
        label: 'Agents per creator',
        value: null,
        source: null,
        enforced: false,
        note: 'No per-creator cap is stored or applied. A creator may enter as many agents as they own.',
      },
      {
        key: 'prize_pool',
        label: 'Prize pool',
        value: null,
        source: null,
        enforced: false,
        note:
          'No prize pool is recorded against a season and no distribution has ever been paid by this ' +
          'platform. Stating a figure here would describe money that does not exist.',
      },
      {
        key: 'evolving_mid_season',
        label: 'Evolving mid-season',
        value: null,
        source: null,
        enforced: false,
        note:
          'Evolution is recorded (see an agent’s Evolution tab) but no season rule permits or ' +
          'forbids it, and no record is reset when it happens.',
      },
    ];

    return {
      season_id: s.id,
      season_name: s.name,
      rules,
      encoded: rules.filter((r) => r.enforced).length,
      described_only: rules.filter((r) => !r.enforced).length,
      note:
        'Every rule this competition would have is listed. The ones marked as not enforced are not ' +
        'applied by anything: they are shown so the shape of the competition is legible and so nobody ' +
        'reads a short list as a complete one.',
      as_of: new Date().toISOString(),
    };
  }

  /**
   * The ticks a season has actually run.
   *
   * A TICK IS THE UNIT OF THE COMPETITION, and its history answers the question
   * a standings table cannot: has this thing been running, or did it stop. Gaps
   * are the whole point, so the days are returned as the days that HAVE ticks
   * and the response says how many distinct days that is against how many days
   * the season has been open. A dense array padded with zeroes would report
   * ticks of zero on days the engine may simply not have existed yet.
   */
  async ticks(seasonId: string) {
    const season = await this.db.query(
      `SELECT id::text, name, start_at, end_at FROM seasons WHERE id = $1`,
      [seasonId],
    );
    if (season.length === 0) throw new NotFoundException(`Season ${seasonId} not found`);
    const s = season[0];

    const [totals, byDay, recent] = await Promise.all([
      this.db.query(
        `SELECT count(t.id)::int AS ticks,
                count(DISTINCT c.id)::int AS competitions,
                min(t.window_start) AS first_tick,
                max(t.window_start) AS last_tick,
                count(*) FILTER (WHERE t.window_end IS NULL)::int AS open_ticks
           FROM competitions c
           LEFT JOIN competition_ticks t ON t.competition_id = c.id
          WHERE c.season_id = $1`,
        [seasonId],
      ),
      this.db.query(
        `SELECT date_trunc('day', t.window_start) AS day, count(*)::int AS ticks
           FROM competition_ticks t
           JOIN competitions c ON c.id = t.competition_id
          WHERE c.season_id = $1
          GROUP BY 1 ORDER BY 1`,
        [seasonId],
      ),
      this.db.query(
        `SELECT t.tick_index, t.phase, t.market_snapshot_ref, t.window_start, t.window_end,
                c.id::text AS competition_id, c.status AS competition_status
           FROM competition_ticks t
           JOIN competitions c ON c.id = t.competition_id
          WHERE c.season_id = $1
          ORDER BY t.window_start DESC LIMIT 40`,
        [seasonId],
      ),
    ]);

    const t = totals[0] ?? {};
    const start = s.start_at ? new Date(s.start_at) : null;
    const end = s.end_at ? new Date(s.end_at) : null;
    const now = new Date();
    const through = end && end < now ? end : now;
    const openDays =
      start && through > start ? Math.max(1, Math.ceil((through.getTime() - start.getTime()) / 86400000)) : null;

    return {
      season_id: s.id,
      season_name: s.name,
      competitions: Number(t.competitions ?? 0),
      ticks: Number(t.ticks ?? 0),
      // A tick with no window_end is one that opened and never closed. Counted
      // separately because it is the difference between "running" and "stuck",
      // and the totals alone cannot tell them apart.
      ticks_still_open: Number(t.open_ticks ?? 0),
      first_tick: t.first_tick ? new Date(t.first_tick).toISOString() : null,
      last_tick: t.last_tick ? new Date(t.last_tick).toISOString() : null,
      days_with_ticks: byDay.length,
      days_season_open: openDays,
      // NOT PADDED WITH ZEROES. A day absent from this array is a day with no
      // recorded tick, which is not the same claim as a day that ran zero.
      by_day: byDay.map((d: { day: Date; ticks: number }) => ({
        day: new Date(d.day).toISOString().slice(0, 10),
        ticks: Number(d.ticks),
      })),
      by_day_note:
        'Days with no recorded tick are absent from this array rather than present with a count of ' +
        'zero. A missing day is a day nothing was written for, which may mean the engine was not ' +
        'running — a different fact from a day it ran and did nothing.',
      recent: recent.map((r: Record<string, any>) => ({
        tick_index: r.tick_index,
        phase: r.phase,
        market_snapshot_ref: r.market_snapshot_ref,
        window_start: r.window_start ? new Date(r.window_start).toISOString() : null,
        window_end: r.window_end ? new Date(r.window_end).toISOString() : null,
        competition_id: r.competition_id,
        competition_status: r.competition_status,
      })),
      as_of: new Date().toISOString(),
    };
  }
}
