import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MIN_DECISIONS, REGIME_WEIGHT_NOTE, SCORE_WEIGHTS, STRATEGY_NOTE, unrankedNote } from '../common/ranking';
import { Page } from '../common/pagination';

/**
 * The leaderboard: agents ordered by a score, computed where the scores are.
 *
 * WHY IT DID NOT EXIST UNTIL NOW, AND WHY THE GAP WAS EASY TO MISS. Two
 * endpoints look like this one and are not:
 *
 *   GET /v1/competitions/:id/standings   scoped to ONE competition and ordered
 *                                        by NAV. Deliberately not the ARCANA
 *                                        Score — ranking a contest by the
 *                                        composite would let an agent lead a
 *                                        contest it is losing.
 *   GET /v1/agents                       configuration: mandate, risk profile,
 *                                        strategy. No score anywhere.
 *
 * So the data existed, in one table, and nothing put it in an order.
 *
 * THE ORDER IS COMPUTED IN SQL. Not because SQL is faster here — at this size
 * it is not — but because a rank computed in the browser is a SECOND
 * definition of rank, and two definitions agree on every day they still agree.
 * `RANK() OVER (...)` also ranks across the whole filtered set rather than the
 * page, so page 2 starts at 26 instead of starting again at 1.
 */

/**
 * The sortable components, and the one that is deliberately absent.
 *
 * `score_snapshots` has eight score columns. Seven are offered. `regime_score`
 * is NOT, and the omission is the point: the market-regime classifier is not
 * implemented (roadmap Mar 2027), and the scoring engine writes a flat neutral
 * placeholder for every agent. Listing it as something you can sort by would
 * present a constant as a measurement — the same failure as showing a dead
 * weight on a chart. It is stated in the response rather than silently dropped,
 * because an absence nobody mentions is indistinguishable from an oversight.
 *
 * Note what is NOT here either: a "NAV" or "return" category. Those belong to
 * standings, which is scoped to one contest and says so.
 */
export const CATEGORIES = {
  overall: {
    column: 'arcana_score',
    label: 'Overall',
    about: 'The composite ARCANA Score. Withheld entirely for an agent that has not competed enough.',
  },
  performance: {
    column: 'performance_score',
    label: 'Performance',
    about: 'Return against the season, before any risk adjustment.',
  },
  risk: {
    column: 'risk_score',
    label: 'Risk-adjusted',
    about: 'Return measured against the drawdown it was taken through. Requires having competed.',
  },
  consistency: {
    column: 'consistency_score',
    label: 'Consistency',
    about: 'How repeatable the record is, rather than how good its best day was. Requires having competed.',
  },
  strategy: {
    column: 'strategy_score',
    label: 'Strategy',
    about: 'How well the agent did what it said it would do.',
  },
  longevity: {
    column: 'longevity_score',
    label: 'Longevity',
    about: 'Time in competition, measured in recorded ticks. Persistence only — never a penalty for being new.',
  },
  creator: {
    column: 'creator_score',
    label: 'Creator',
    about: "The creator's peer-derived reputation from the previous run.",
  },
} as const;

export type Category = keyof typeof CATEGORIES;

const REGIME_NOTE =
  'score_snapshots also carries regime_score. It is not offered here and not printed: the ' +
  'market-regime classifier is not implemented (roadmap Mar 2027) and the scoring engine writes ' +
  'the same neutral placeholder for every agent, so ordering by it would rank nothing and ' +
  'displaying it would present a constant as a measurement.';

export interface LeaderboardEntry {
  rank: number | null;
  agent_id: string;
  agent_name: string;
  version: number;
  status: string;
  strategy_type: string | null;
  creator: { id: string; handle: string } | null;
  score: number | null;
  scores: Record<string, number | null>;
  decisions: number;
  ranked: boolean;
  unranked_note: string | null;
  as_of: string;
}

@Injectable()
export class LeaderboardService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async list(opts: {
    seasonId?: string;
    category: string;
    page: number;
    pageSize: number;
    offset: number;
    includeUnranked: boolean;
    q?: string;
    universe?: string;
    status?: string;
    minScore?: number;
    maxScore?: number;
  }) {
    const category = this.parseCategory(opts.category);
    const column = CATEGORIES[category].column;
    const season = await this.resolveSeason(opts.seasonId);

    // ONE ROW PER AGENT: the LATEST snapshot in this season.
    //
    // score_snapshots is a time series — one row per scoring run — so without
    // this an agent appears once per run and a busy agent floods the board.
    // DISTINCT ON is the narrow way to say "the newest per agent" in Postgres,
    // and it is inside a CTE so the ranking below sees one row each.
    //
    // RANKED-NESS IS READ FROM THE STORED VERDICT, not recomputed. The scoring
    // engine writes NULL into arcana_score when an agent is below the decision
    // threshold; that NULL IS the verdict, and re-deriving it here from a
    // decision count would be a second definition of ranked that could disagree
    // with the score sitting beside it. The count is still read — to say WHY —
    // but it does not decide.
    const sql = `
      WITH latest AS (
        SELECT DISTINCT ON (s.agent_id)
               s.agent_id, s.ts, s.season_id,
               s.arcana_score, s.performance_score, s.risk_score, s.strategy_score,
               s.consistency_score, s.creator_score, s.longevity_score
          FROM score_snapshots s
         WHERE s.season_id = $1
         ORDER BY s.agent_id, s.ts DESC
      ),
      joined AS (
        SELECT l.*,
               a.name AS agent_name, a.version, a.status, a.strategy_type,
               c.id AS creator_id, c.handle AS creator_handle,
               (l.arcana_score IS NOT NULL) AS ranked,
               coalesce(d.n, 0) AS decisions
          FROM latest l
          JOIN agents a ON a.id = l.agent_id
          LEFT JOIN creators c ON c.id = a.creator_id
          -- decisions_counted, NOT decisions. The view excludes rows marked as
          -- measurement artefacts, and counting the raw table would credit an
          -- agent with duplicates that migration 0036 already ruled out.
          LEFT JOIN (
            SELECT agent_id, count(*)::int AS n FROM decisions_counted GROUP BY agent_id
          ) d ON d.agent_id = l.agent_id
         WHERE ($2::boolean OR l.arcana_score IS NOT NULL)
           -- EVERY FILTER IS APPLIED HERE, INSIDE THE CTE, so the rank window
           -- below ranks the filtered set. Filtering after ranking would leave
           -- gaps — rows 1, 4, 9 — and a reader would reasonably conclude the
           -- missing ones had been hidden rather than never matched.
           AND ($3::text IS NULL OR a.name ILIKE '%' || $3 || '%'
                                 OR c.handle ILIKE '%' || $3 || '%')
           AND ($4::text IS NULL OR a.asset_universe = $4)
           AND ($5::text IS NULL OR a.status = $5)
      )
      SELECT *,
             -- THE RANK IS OVER THE WHOLE FILTERED SET, not the page, so page 2
             -- continues at 26 rather than starting again at 1.
             --
             -- AND ONLY RANKED AGENTS GET ONE. An unranked agent still has a
             -- performance_score, so ordering by that column alone would put an
             -- agent that has not competed above agents that have — the exact
             -- failure the scoring engine avoids by writing NULL into the
             -- composite. They are listed, after, with rank NULL.
             -- A TIE IS RANKED AS A TIE. The window orders by the score ALONE,
             -- deliberately not by the name that breaks ties in the row order
             -- below. Adding agent_name here would hand two agents with the
             -- same score the numbers 1 and 2, and a page printing "1st" and
             -- "2nd" would be asserting a difference the data does not contain
             -- — the same class of lie as a tidy 0.0000 standing in for a
             -- measurement nobody took.
             --
             -- rank() (not dense_rank()) is the right one: equal scores share a
             -- number and the next agent SKIPS, so rank 3 after two firsts
             -- still means "two agents are ahead of you", which is true.
             --
             -- The row ORDER BY keeps agent_name so paging stays stable and
             -- deterministic. Order and rank are different questions: the list
             -- must have one order, the scoreboard must not invent one.
             CASE WHEN ranked
                  THEN rank() OVER (PARTITION BY ranked ORDER BY ${column} DESC NULLS LAST)
                  END AS rank,
             count(*) OVER () AS total,
             count(*) FILTER (WHERE ranked) OVER () AS total_ranked
        FROM joined
       -- agent_id IS THE LAST TIEBREAK, AND IT IS NOT DECORATION.
       -- (score, agent_name) was assumed to be a total order and is not: two
       -- agents can share a score AND a name — this platform has two agents
       -- called momentum_bot — at which point Postgres returns them in
       -- whichever order it likes, and it does not have to be the same order
       -- twice. A row can then appear on both page 1 and page 2, or on
       -- neither, and the total still adds up so nothing looks wrong.
       --
       -- Caught by leaderboard-verify computing the same ordering a second way
       -- and getting a different answer for strategy and longevity.
       --
       -- This changes ORDER only. The RANK window above still orders by the
       -- score alone, so a tie is still ranked as a tie: the id decides who is
       -- PRINTED first, never who is placed higher.
       -- The score bounds are applied against the COLUMN BEING RANKED, after
       -- the window so the rank still counts every agent that matched the other
       -- filters. A board filtered to "score >= 60" is showing a slice of a real
       -- ranking, not a ranking of a slice.
       WHERE ($6::float8 IS NULL OR ${column} >= $6)
         AND ($7::float8 IS NULL OR ${column} <= $7)
       ORDER BY ranked DESC, ${column} DESC NULLS LAST, agent_name ASC, agent_id ASC
       LIMIT $8 OFFSET $9`;

    // THE FILTER OPTIONS, COUNTED OVER THE WHOLE SEASON AND NOT OVER THE PAGE.
    //
    // A facet list built from the rows currently shown disappears as you use
    // it: filter to one universe and the other options vanish, so there is no
    // way back except clearing by hand. These are every universe and status
    // present in the season, whatever the current filters are.
    const facets = await this.db.query(
      `SELECT DISTINCT a.asset_universe AS universe, a.status
         FROM score_snapshots s
         JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
        WHERE s.season_id = $1`,
      [season.id],
    );

    const rows = await this.db.query(sql, [
      season.id, opts.includeUnranked,
      opts.q ?? null, opts.universe ?? null, opts.status ?? null,
      opts.minScore ?? null, opts.maxScore ?? null,
      opts.pageSize, opts.offset,
    ]);

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    const totalRanked = rows.length > 0 ? Number(rows[0].total_ranked) : 0;
    const entries: LeaderboardEntry[] = rows.map((r: any) => ({
      rank: r.rank === null ? null : Number(r.rank),
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      version: r.version,
      status: r.status,
      strategy_type: r.strategy_type,
      creator: r.creator_id ? { id: r.creator_id, handle: r.creator_handle } : null,
      score: num(r[column]),
      // EVERY COMPONENT ON EVERY ROW, so a tab switch is a re-sort rather than
      // seven round trips — and so a reader can see that the agent leading on
      // performance is fourth on risk, which is the thing worth knowing.
      scores: {
        overall: num(r.arcana_score),
        performance: num(r.performance_score),
        risk: num(r.risk_score),
        consistency: num(r.consistency_score),
        strategy: num(r.strategy_score),
        longevity: num(r.longevity_score),
        creator: num(r.creator_score),
      },
      decisions: Number(r.decisions ?? 0),
      ranked: r.ranked === true,
      unranked_note: r.ranked === true ? null : unrankedNote(Number(r.decisions ?? 0)),
      as_of: r.ts,
    }));

    const page: Page<LeaderboardEntry> = {
      items: entries,
      page: opts.page,
      page_size: opts.pageSize,
      total,
      has_more: opts.page * opts.pageSize < total,
    };

    return {
      ...page,
      season: { id: season.id, name: season.name, status: season.status },
      category,
      category_column: column,
      category_about: CATEGORIES[category].about,
      // THE WEIGHT IS ON THE CATEGORY, so a page showing a breakdown does not
      // have to keep its own copy of the formula. `overall` is the composite
      // itself and has no weight; `strategy` has none because it is a
      // multiplier rather than a term.
      categories: Object.entries(CATEGORIES).map(([key, v]) => ({
        key, label: v.label, about: v.about,
        weight: SCORE_WEIGHTS[key] ?? null,
        weight_note:
          key === 'strategy' ? STRATEGY_NOTE
          : key === 'regime' ? REGIME_WEIGHT_NOTE
          : null,
      })),
      weights_sum: Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0),
      strategy_note: STRATEGY_NOTE,
      include_unranked: opts.includeUnranked,
      threshold_decisions: MIN_DECISIONS,
      facets: {
        universes: [...new Set(facets.map((f: any) => f.universe).filter(Boolean))].sort(),
        statuses: [...new Set(facets.map((f: any) => f.status).filter(Boolean))].sort(),
      },
      total_ranked: totalRanked,
      total_unranked: total - totalRanked,
      regime_note: REGIME_NOTE,
      note: this.note(total, totalRanked, opts.includeUnranked, category),
    };
  }

  /**
   * The season a leaderboard is of.
   *
   * DEFAULTS TO THE ONE THAT HAS SCORES, not to the newest season. A season
   * opened an hour ago has no snapshots, and defaulting to it would answer an
   * unqualified request with an empty board — which reads as "nobody is
   * competing" rather than "this season has not been scored yet".
   */
  /**
   * The season id a caller means, resolved the same way the board resolves it.
   *
   * Public so the series route lands on the SAME season the leaderboard does.
   * Two resolutions of "which season" is how a page ends up joining one
   * season’s ranks to another season’s returns and showing both as one row.
   */
  async resolveSeasonId(seasonId?: string): Promise<string> {
    return (await this.resolveSeason(seasonId)).id;
  }

  private async resolveSeason(seasonId?: string) {
    // STATUS IS DERIVED FROM THE DATES. `seasons` has no status column and
    // deliberately should not grow one — seasons.service.ts sets that out: a
    // stored status is a second source of truth that drifts the moment an
    // operator moves end_at. The same three words are derived here rather than
    // a fourth spelling being invented for this endpoint.
    const status = `CASE WHEN now() < s.start_at THEN 'upcoming'
                        WHEN now() > s.end_at   THEN 'ended'
                        ELSE 'running' END AS status`;
    if (seasonId) {
      const rows = await this.db.query(
        `SELECT s.id::text, s.name, ${status} FROM seasons s WHERE s.id = $1`, [seasonId]);
      if (rows.length === 0) throw new NotFoundException(`Season ${seasonId} not found`);
      return rows[0];
    }
    const rows = await this.db.query(
      `SELECT s.id::text, s.name, ${status}
         FROM seasons s
         JOIN score_snapshots ss ON ss.season_id = s.id
        GROUP BY s.id, s.name, s.start_at, s.end_at
        ORDER BY max(ss.ts) DESC
        LIMIT 1`);
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'no_scored_season',
        message:
          'No season has been scored yet, so there is no leaderboard to show. This is not an ' +
          'empty leaderboard — it is the absence of one, and the difference matters: an empty ' +
          'board says nobody is competing.',
      });
    }
    return rows[0];
  }

  private parseCategory(raw: string): Category {
    const key = (raw || 'overall').toLowerCase();
    if (key in CATEGORIES) return key as Category;
    // REFUSED, NOT IGNORED. `GET /v1/agents?sort=score` answers 200 and quietly
    // ignores the parameter, which is how a frontend ends up believing it asked
    // for something it did not get. An unknown category is a question.
    throw new BadRequestException({
      code: 'unknown_category',
      message:
        `'${String(raw).slice(0, 32)}' is not a leaderboard category. Available: ` +
        `${Object.keys(CATEGORIES).join(', ')}. ` +
        (key === 'regime' || key === 'regime_score' ? REGIME_NOTE : ''),
    });
  }

  private note(total: number, ranked: number, includeUnranked: boolean, category: Category): string {
    if (total === 0) {
      return includeUnranked
        ? 'No agent has been scored in this season yet.'
        : `No agent in this season has reached ${MIN_DECISIONS} decisions yet. Pass ` +
          'include_unranked=true to see the agents that are competing but not yet ranked.';
    }
    const parts = [`${ranked} ranked agent(s) ordered by ${CATEGORIES[category].label.toLowerCase()}.`];
    if (includeUnranked && total > ranked) {
      parts.push(
        `${total - ranked} more are listed WITHOUT a rank: they have fewer than ${MIN_DECISIONS} ` +
        'decisions, so they have not competed enough to be placed. They appear after the ranked ' +
        'agents and are never interleaved with them.');
    } else if (!includeUnranked) {
      parts.push('Agents below the decision threshold are not shown; pass include_unranked=true to list them.');
    }
    return parts.join(' ');
  }
}

/** numeric columns arrive as strings from pg; NULL stays NULL rather than becoming 0. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
