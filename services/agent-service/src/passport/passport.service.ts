import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EvolutionService } from '../evolution/evolution.service';
import { MIN_DECISIONS } from '../common/ranking';

/**
 * Agent Passport — the career record: what an agent has been through.
 *
 * A READ-MODEL, deliberately. Nothing here is stored in a passport table and
 * nothing can be written to it: every line is derived on request from
 * decisions, portfolio_snapshots, score_snapshots, agent_dna and agents. A
 * career record that can be written to can lie; one derived from the
 * append-only decision log cannot.
 *
 * That also means the passport costs a handful of queries per request rather
 * than a background job. If it ever needs caching, the cache must stay
 * recomputable from these same sources and must not become the truth.
 *
 * Its companion is Agent DNA: DNA answers "how does this agent behave",
 * the passport answers "what has this agent been through".
 */

/**
 * Below this an agent has not competed. Same threshold as the scoring engine's
 * participation rule and Agent DNA, and it governs the same thing here: an
 * agent that has not competed still gets a passport — it exists, it was
 * registered, that is a fact worth showing — but it holds no rank and no
 * badges, because those are claims about competing.
 */

/**
 * Ticks at which `longevity_score` saturates in the scoring formula. Reused as
 * the `seasoned` badge threshold rather than inventing a round number: it is
 * the point the platform already treats as a full run.
 */
const SEASONED_TICKS = 20;

/** Consecutive scoring runs inspected for the label-consistency badge. */
const TRUE_TO_FORM_RUNS = 20;
const TRUE_TO_FORM_MIN_SCORE = 95;

/** Recent score points returned when the full series is not requested. */
const SCORE_HISTORY_PREVIEW = 12;

export interface Badge {
  code: string;
  label: string;
  /** The rule in words, so a holder can be told why they have it. */
  criterion: string;
  awarded_at: string | null;
  /** The numbers that satisfied the rule — never a bare boolean. */
  evidence: Record<string, unknown>;
}

@Injectable()
export class PassportService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly evolution: EvolutionService,
  ) {}

  async getPassport(agentId: string, fullHistory: boolean) {
    const agent = await this.loadAgent(agentId);
    const participation = await this.loadParticipation(agentId);
    const ranked = participation.decisions >= MIN_DECISIONS;

    const seasons = await this.loadSeasonRecords(agentId);
    const scores = await this.loadScoreHistory(agentId);
    const dna = await this.loadDna(agentId);
    const lineage = await this.loadLineage(agentId, agent.version);
    const badges = ranked ? await this.loadBadges(agentId, seasons, scores.series) : [];
    const protection = await this.loadProtection(agentId);

    // Only agents that actually have a lineage pay for the evolution read: it
    // loads the market index, and most agents are a single version with nothing
    // to compare.
    const hasLineage =
      lineage.ancestors.length > 0 || lineage.descendants.length > 0;
    const evolution = hasLineage
      ? await this.evolution.getEvolution(agentId)
      : null;

    const totalTicks = seasons.reduce((a, s) => a + s.ticks, 0);

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        status: agent.status,
        strategy_type: agent.strategy_type,
        asset_universe: agent.asset_universe,
        created_at: agent.created_at,
      },
      creator: agent.creator_id
        ? {
            id: agent.creator_id,
            handle: agent.creator_handle,
            reputation_score: numeric(agent.creator_reputation),
          }
        : null,
      participation: {
        ranked,
        threshold_decisions: MIN_DECISIONS,
        decisions: participation.decisions,
        trades: participation.trades,
        // Spelled out rather than left to the reader to infer from `ranked`.
        status: ranked
          ? 'competing'
          : participation.decisions === 0
            ? 'registered, has not competed'
            : `registered, ${participation.decisions} of ${MIN_DECISIONS} decisions needed to be ranked`,
      },
      career: {
        active_since: agent.created_at,
        first_tick: seasons.length > 0 ? seasons[seasons.length - 1].first_tick : null,
        last_tick: seasons.length > 0 ? seasons[0].last_tick : null,
        seasons_entered: seasons.length,
        total_ticks: totalTicks,
        total_decisions: participation.decisions,
        total_trades: participation.trades,
      },
      // WHO DECIDED THE TRADES. A protective exit is a real trade with a real
      // transaction, and it was not this agent's judgement — a level set when
      // the position opened crossed, and a watcher with no model acted on it.
      // Reading a track record without this split would credit an agent for
      // being saved by its own stop loss.
      decided_by: {
        own: participation.own_trades,
        protective: participation.protective_exits,
        stop_loss: participation.stop_losses,
        take_profit: participation.take_profits,
        // Rows that predate the distinction. Not folded into either side:
        // "we do not know" is a different statement from "the agent decided".
        unattributed: participation.unattributed_trades,
        note:
          participation.protective_exits > 0
            ? `${participation.protective_exits} of ${participation.trades} trades were protective exits ` +
              `(${participation.stop_losses} stop loss, ${participation.take_profits} take profit), ` +
              'decided by a level rather than by the agent.'
            : 'Every trade was the agent\'s own decision.',
      },
      // WHAT IS WATCHING THE OPEN POSITIONS, AND AT WHAT NUMBER.
      //
      // Until now an armed level existed only inside the rationale of the
      // decision that opened the position — true, and findable only by someone
      // who already suspected something. That is how an owner who wrote "get
      // out if it drops 0.15%" ended up with a stop 15% away and no way to see
      // it: both numbers are legitimate, the record stated the one that was
      // armed, and nobody was ever shown the two side by side.
      //
      // THIS IS VISIBILITY, NOT A LIMIT. A 15% stop is a perfectly good stop if
      // that is what its owner wanted; what was wrong was that it was not what
      // they asked for. Nothing here refuses a wide level, and nothing here
      // refuses a narrow one — the percentage is simply stated, in words, where
      // the owner is already looking.
      protection,
      season_records: seasons,
      score_history: {
        runs: scores.series.length,
        first: scores.series[0] ?? null,
        peak: scores.peak,
        latest: scores.series[scores.series.length - 1] ?? null,
        // The full series grows without bound; the default payload carries a
        // recent window so the passport stays cheap enough to embed in a
        // listing. ?history=full returns everything.
        series: fullHistory
          ? scores.series
          : scores.series.slice(-SCORE_HISTORY_PREVIEW),
        truncated: !fullHistory && scores.series.length > SCORE_HISTORY_PREVIEW,
      },
      dna,
      lineage,
      // Present only when there is more than one version. The full comparison
      // also lives at GET /v1/agents/:id/evolution.
      evolution: evolution
        ? { versions: evolution.versions, comparisons: evolution.comparisons, caveat: evolution.caveat }
        : null,
      badges,
    };
  }

  // -------------------------------------------------------------------------

  private async loadAgent(agentId: string) {
    const rows = await this.db.query(
      `SELECT a.id, a.name, a.version, a.status, a.strategy_type, a.asset_universe,
              a.created_at, a.parent_agent_id,
              c.id AS creator_id, c.handle AS creator_handle,
              c.reputation_score AS creator_reputation
       FROM agents a LEFT JOIN creators c ON c.id = a.creator_id
       WHERE a.id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    return rows[0];
  }

  /**
   * Armed levels and unprotected positions, as one answer.
   *
   * Both statuses in one query and one block, because the question an owner has
   * is "what is watching my positions" and the honest answer includes the
   * positions nothing is watching. Splitting them would let the empty half go
   * unnoticed, which is the failure mode this exists for.
   */
  private async loadProtection(agentId: string) {
    const rows = await this.db.query(
      `SELECT id, symbol, status,
              entry_price::float8        AS entry_price,
              entry_qty::float8          AS entry_qty,
              stop_loss::float8          AS stop_loss,
              take_profit::float8        AS take_profit,
              stop_loss_pct::float8      AS stop_loss_fraction,
              take_profit_pct::float8    AS take_profit_fraction,
              min_acceptable_pct::float8 AS min_acceptable_fraction,
              set_at, last_refusal_at, last_refusal_reason, note
         FROM position_guards
        WHERE agent_id = $1 AND subscription_id IS NULL AND status IN ('armed', 'refused')
        ORDER BY set_at DESC`,
      [agentId],
    );
    const pct = (v: number | null) =>
      v === null || v === undefined ? null : Number((v * 100).toFixed(4));
    const armed = rows
      .filter((g: any) => g.status === 'armed')
      .map((g: any) => ({
        symbol: g.symbol,
        entry_price: g.entry_price,
        stop_loss: g.stop_loss,
        take_profit: g.take_profit,
        // BOTH SCALES, NAMED. The fraction is what the agent asked for and what
        // the engine stores; the percent is what a person reads. Printing only
        // one of them is how 0.15 and 0.15% became the same thing.
        stop_loss_fraction: g.stop_loss_fraction,
        stop_loss_percent: pct(g.stop_loss_fraction),
        take_profit_fraction: g.take_profit_fraction,
        take_profit_percent: pct(g.take_profit_fraction),
        set_at: g.set_at,
        held_back_since: g.last_refusal_at,
        held_back_because: g.last_refusal_reason,
      }));
    const unprotected = rows
      .filter((g: any) => g.status === 'refused')
      .map((g: any) => ({
        symbol: g.symbol,
        entry_price: g.entry_price,
        smallest_accepted_fraction: g.min_acceptable_fraction,
        smallest_accepted_percent: pct(g.min_acceptable_fraction),
        because: g.note,
      }));
    return { armed, unprotected, note: this.protectionNote(armed, unprotected) };
  }

  /** One sentence stating the numbers, so a wrong one is visible rather than findable. */
  private protectionNote(armed: any[], unprotected: any[]): string {
    const parts: string[] = [];
    for (const g of armed) {
      const bits: string[] = [];
      if (g.stop_loss_percent !== null) {
        bits.push(`a stop ${g.stop_loss_percent}% below the ${g.entry_price} paid (${g.stop_loss})`);
      }
      if (g.take_profit_percent !== null) {
        bits.push(`a target ${g.take_profit_percent}% above it (${g.take_profit})`);
      }
      if (bits.length) parts.push(`${g.symbol} is watched by ${bits.join(' and ')}.`);
      if (g.held_back_since) {
        parts.push(`${g.symbol} crossed a level and the exit was NOT taken: ${g.held_back_because}.`);
      }
    }
    for (const g of unprotected) {
      parts.push(
        `${g.symbol} is OPEN AND UNPROTECTED` +
        (g.smallest_accepted_percent !== null
          ? ` — the smallest level its pool accepts is ${g.smallest_accepted_percent}%`
          : '') + '.');
    }
    if (parts.length === 0) {
      return 'No protective levels are set. That is not a failure — a level is armed only when ' +
        'one is asked for — but nothing is watching these positions between ticks.';
    }
    // SAID IN WORDS, because the whole point is that a number in a field is
    // easy to skim past and a sentence naming it is not.
    parts.push(
      'These are the levels actually armed, measured from the price actually paid. If one of ' +
      'them is not the number you asked for in the mandate or the risk profile, it is the ' +
      'number that will fire: write the level as a FRACTION (0.0015 is 0.15%, 0.05 is 5%) ' +
      'under stop_loss_fraction or take_profit_fraction.');
    return parts.join(' ');
  }

  private async loadParticipation(agentId: string) {
    // WHO DECIDED, counted separately from WHAT HAPPENED.
    //
    // An agent that made money because its stop loss worked and an agent whose
    // calls were good are two different agents, and until `decider` carried
    // 'protective' the record could not tell them apart: both produced a row
    // with action='sell'. The counts below are the whole point of that column.
    //
    // `decider IS NULL` is not folded into either bucket by accident: rows
    // written before the distinction existed genuinely do not say, and putting
    // them in the agent's own column would overstate what is known.
    const rows = await this.db.query(
      `SELECT COUNT(*)::int AS decisions,
              COUNT(*) FILTER (WHERE action <> 'hold')::int AS trades,
              COUNT(*) FILTER (WHERE action <> 'hold'
                                 AND decider = 'protective')::int AS protective_exits,
              COUNT(*) FILTER (WHERE action <> 'hold'
                                 AND decider IS NOT NULL
                                 AND decider <> 'protective')::int AS own_trades,
              COUNT(*) FILTER (WHERE action <> 'hold' AND decider IS NULL)::int AS unattributed_trades,
              COUNT(*) FILTER (WHERE reason_code = 'stop_loss')::int AS stop_losses,
              COUNT(*) FILTER (WHERE reason_code = 'take_profit')::int AS take_profits
       FROM decisions_counted WHERE agent_id = $1`,
      [agentId],
    );
    return rows[0] ?? { decisions: 0, trades: 0, protective_exits: 0, own_trades: 0,
      unattributed_trades: 0, stop_losses: 0, take_profits: 0 };
  }

  /**
   * One record per season the agent actually has a portfolio in.
   *
   * The season's own start_at/end_at is NOT used to bound the record. Season 1
   * declares 2026-10-01..12-31 while every one of its ticks is dated
   * 2026-09-08, so bounding by the calendar would return an empty career for a
   * season the agent demonstrably competed in. The agent's own first and last
   * recorded tick is the evidence; the declared window is a plan.
   */
  private async loadSeasonRecords(agentId: string) {
    const rows = await this.db.query(
      `SELECT s.id AS season_id, s.name AS season_name, s.universe,
              s.start_at, s.end_at,
              COUNT(ps.*)::int AS ticks,
              MIN(ps.ts) AS first_tick,
              MAX(ps.ts) AS last_tick,
              MIN(ps.nav) AS lowest_nav,
              MAX(ps.nav) AS highest_nav
       FROM portfolios p
       JOIN seasons s ON s.id = p.season_id
       LEFT JOIN portfolio_snapshots ps ON ps.portfolio_id = p.id
       WHERE p.agent_id = $1
       GROUP BY s.id, s.name, s.universe, s.start_at, s.end_at
       ORDER BY MAX(ps.ts) DESC NULLS LAST`,
      [agentId],
    );

    const out = [];
    for (const r of rows) {
      const standing = await this.seasonStanding(agentId, r.season_id);
      const window = await this.seasonScores(agentId, r.season_id);
      out.push({
        season_id: r.season_id,
        season_name: r.season_name,
        universe: r.universe,
        ticks: r.ticks,
        first_tick: r.first_tick,
        last_tick: r.last_tick,
        lowest_nav: numeric(r.lowest_nav),
        highest_nav: numeric(r.highest_nav),
        // A season is only "final" once its declared end has passed. Until
        // then the rank is a current standing, not a result.
        status: new Date(r.end_at) < new Date() ? 'final' : 'in_progress',
        declared_window: { start_at: r.start_at, end_at: r.end_at },
        rank: standing.rank,
        ranked_participants: standing.ranked_participants,
        total_participants: standing.total_participants,
        peak_arcana_score: window.peak,
        peak_at: window.peak_at,
        final_arcana_score: window.latest,
      });
    }
    return out;
  }

  /** Current standing among the agents holding a portfolio in this season. */
  private async seasonStanding(agentId: string, seasonId: string) {
    const rows = await this.db.query(
      `WITH participants AS (
         SELECT DISTINCT agent_id FROM portfolios WHERE season_id = $2
       ), latest AS (
         SELECT DISTINCT ON (s.agent_id) s.agent_id, s.arcana_score
         FROM score_snapshots s JOIN participants x ON x.agent_id = s.agent_id
         ORDER BY s.agent_id, s.ts DESC
       ), ranked AS (
         SELECT agent_id, arcana_score,
                RANK() OVER (ORDER BY arcana_score DESC) AS rk,
                COUNT(*) OVER () AS ranked_participants
         FROM latest WHERE arcana_score IS NOT NULL
       )
       SELECT r.rk::int AS rank, r.ranked_participants::int,
              (SELECT COUNT(*)::int FROM participants) AS total_participants
       FROM ranked r WHERE r.agent_id = $1`,
      [agentId, seasonId],
    );
    if (rows.length === 0) {
      const totals = await this.db.query(
        `SELECT COUNT(DISTINCT agent_id)::int AS total FROM portfolios WHERE season_id = $1`,
        [seasonId],
      );
      // Unranked agents take no place among those who competed.
      return { rank: null, ranked_participants: null, total_participants: totals[0]?.total ?? 0 };
    }
    return {
      rank: rows[0].rank,
      ranked_participants: rows[0].ranked_participants,
      total_participants: rows[0].total_participants,
    };
  }

  /**
   * Peak and final score for one season, read from the season the score was
   * actually recorded against.
   *
   * This used to infer the season by asking which scores fell between the
   * agent's first and last recorded tick, because score_snapshots carried no
   * season_id. That inference is gone: migration 0022 added the column, so the
   * attribution is now recorded rather than re-derived on every read.
   *
   * The old note said the window was "unambiguous while an agent competes in
   * one season at a time" — which was true, and stopped being true the moment
   * Season 2 opened with the same agents. Worse, a window is a claim about
   * time, and Season 1's ticks and Season 2's ticks are only separated by when
   * they happened; two seasons running concurrently would have silently mixed.
   */
  private async seasonScores(agentId: string, seasonId: string) {
    const rows = await this.db.query(
      `SELECT MAX(arcana_score) AS peak,
              (SELECT ts FROM score_snapshots
                WHERE agent_id = $1 AND season_id = $2 AND arcana_score IS NOT NULL
                ORDER BY arcana_score DESC, ts ASC LIMIT 1) AS peak_at,
              (SELECT arcana_score FROM score_snapshots
                WHERE agent_id = $1 AND season_id = $2 AND arcana_score IS NOT NULL
                ORDER BY ts DESC LIMIT 1) AS latest
       FROM score_snapshots
       WHERE agent_id = $1 AND season_id = $2 AND arcana_score IS NOT NULL`,
      [agentId, seasonId],
    );
    const r = rows[0] ?? {};
    return { peak: numeric(r.peak), peak_at: r.peak_at ?? null, latest: numeric(r.latest) };
  }

  private async loadScoreHistory(agentId: string) {
    const rows = await this.db.query(
      // season_id travels with every point so a chart can break the line where
      // the market changed. Season 1's scores were earned against simulator
      // prices and Season 2's against real ones; drawing one continuous curve
      // through both would show a career that never happened.
      `SELECT ts, season_id, arcana_score, performance_score, risk_score, consistency_score,
              strategy_score, longevity_score
       FROM score_snapshots WHERE agent_id = $1 ORDER BY ts ASC`,
      [agentId],
    );
    const series = rows.map((r: any) => ({
      ts: r.ts,
      season_id: r.season_id,
      arcana_score: numeric(r.arcana_score),
      performance_score: numeric(r.performance_score),
      risk_score: numeric(r.risk_score),
      consistency_score: numeric(r.consistency_score),
      strategy_score: numeric(r.strategy_score),
      longevity_score: numeric(r.longevity_score),
    }));

    let peak: { ts: unknown; arcana_score: number } | null = null;
    for (const p of series) {
      if (p.arcana_score != null && (peak == null || p.arcana_score > peak.arcana_score)) {
        peak = { ts: p.ts, arcana_score: p.arcana_score };
      }
    }
    return { series, peak };
  }

  /** DNA is owned by the DNA module; the passport displays it, never recomputes it. */
  private async loadDna(agentId: string) {
    const rows = await this.db.query(
      `SELECT risk_personality, regime_strengths, computed_at
       FROM agent_dna WHERE agent_id = $1`,
      [agentId],
    );
    if (rows.length === 0) return null;
    const { features, ...risk } = rows[0].risk_personality ?? {};
    return {
      computed_at: rows[0].computed_at,
      features: features ?? null,
      risk_personality: risk,
      regime_strengths: rows[0].regime_strengths,
    };
  }

  /**
   * Version chain through parent_agent_id.
   *
   * The Agent Evolution flow that would create these links is not built yet
   * (roadmap Jan 2027) — this reads whatever lineage exists and renders it.
   * One chain already exists in the data from an early manual insert, so the
   * structure is exercised rather than merely declared.
   */
  private async loadLineage(agentId: string, version: number) {
    const ancestors = await this.db.query(
      `WITH RECURSIVE up AS (
         SELECT id, name, version, parent_agent_id, status, created_at, 0 AS depth
         FROM agents WHERE id = $1
         UNION ALL
         SELECT a.id, a.name, a.version, a.parent_agent_id, a.status, a.created_at, up.depth + 1
         FROM agents a JOIN up ON a.id = up.parent_agent_id
       )
       SELECT id, name, version, status, created_at, depth FROM up WHERE depth > 0 ORDER BY depth ASC`,
      [agentId],
    );
    const descendants = await this.db.query(
      `WITH RECURSIVE down AS (
         SELECT id, name, version, parent_agent_id, status, created_at, 0 AS depth
         FROM agents WHERE id = $1
         UNION ALL
         SELECT a.id, a.name, a.version, a.parent_agent_id, a.status, a.created_at, down.depth + 1
         FROM agents a JOIN down ON a.parent_agent_id = down.id
       )
       SELECT id, name, version, status, created_at, depth FROM down WHERE depth > 0 ORDER BY depth ASC`,
      [agentId],
    );
    return {
      version,
      ancestors: ancestors.map(lineageRow),
      descendants: descendants.map(lineageRow),
      // True only when nothing links to or from this agent.
      is_original: ancestors.length === 0,
    };
  }

  // -------------------------------------------------------------------------
  // Badges
  // -------------------------------------------------------------------------

  /**
   * Every badge states a rule that can be recomputed from the tables, and
   * carries the numbers that satisfied it. A boolean flag would be a claim;
   * this is a citation.
   *
   * Badges are only awarded to agents past the participation threshold. They
   * are claims about competing, and an agent that has not competed cannot hold
   * one — which also keeps a pre-fix artefact out of the record: an idle agent
   * did briefly top the leaderboard back when a flat NAV scored 100 on risk.
   */
  private async loadBadges(
    agentId: string,
    seasons: Array<{ season_id: string; season_name: string; ticks: number }>,
    series: Array<{ strategy_score: number | null; ts: unknown }>,
  ): Promise<Badge[]> {
    const badges: Badge[] = [];

    // --- ever held rank 1 among a season's ranked participants ---
    for (const s of seasons) {
      const rows = await this.db.query(
        `WITH participants AS (
           SELECT DISTINCT agent_id FROM portfolios WHERE season_id = $2
         ), ranked AS (
           SELECT sc.ts, sc.agent_id, sc.arcana_score,
                  RANK() OVER (PARTITION BY sc.ts ORDER BY sc.arcana_score DESC) AS rk,
                  COUNT(*) OVER (PARTITION BY sc.ts) AS field
           FROM score_snapshots sc JOIN participants p ON p.agent_id = sc.agent_id
           WHERE sc.arcana_score IS NOT NULL
         )
         SELECT MIN(ts) AS first_held_at, COUNT(*)::int AS times_held,
                MAX(arcana_score) AS best_score, MAX(field)::int AS field
         FROM ranked WHERE agent_id = $1 AND rk = 1`,
        [agentId, s.season_id],
      );
      const r = rows[0];
      if (r?.times_held > 0) {
        badges.push({
          code: 'season_leader',
          label: 'Season Leader',
          criterion:
            'Held rank 1 by ARCANA Score among the ranked participants of a season, in at least one scoring run.',
          awarded_at: r.first_held_at,
          evidence: {
            season_id: s.season_id,
            season_name: s.season_name,
            first_held_at: r.first_held_at,
            scoring_runs_held: r.times_held,
            best_score_while_leading: numeric(r.best_score),
            field_size: r.field,
          },
        });
      }
    }

    // --- completed a full longevity cycle in one season ---
    for (const s of seasons) {
      if (s.ticks >= SEASONED_TICKS) {
        badges.push({
          code: 'seasoned',
          label: 'Seasoned',
          criterion: `Recorded at least ${SEASONED_TICKS} ticks in a single season — the point at which longevity_score saturates in the ARCANA Score.`,
          awarded_at: null,
          evidence: {
            season_id: s.season_id,
            season_name: s.season_name,
            ticks: s.ticks,
            threshold: SEASONED_TICKS,
          },
        });
      }
    }

    // --- behaved as declared, sustained ---
    const recent = series.slice(-TRUE_TO_FORM_RUNS);
    const scored = recent.filter((p) => p.strategy_score != null);
    if (
      scored.length === TRUE_TO_FORM_RUNS &&
      scored.every((p) => (p.strategy_score as number) >= TRUE_TO_FORM_MIN_SCORE)
    ) {
      const lowest = Math.min(...scored.map((p) => p.strategy_score as number));
      badges.push({
        code: 'true_to_form',
        label: 'True to Form',
        criterion: `strategy_score stayed at or above ${TRUE_TO_FORM_MIN_SCORE} across the last ${TRUE_TO_FORM_RUNS} scoring runs — conduct matched the declared strategy_type, sustained rather than momentary.`,
        awarded_at: (scored[0].ts as string) ?? null,
        evidence: {
          runs_checked: TRUE_TO_FORM_RUNS,
          lowest_strategy_score: lowest,
          since: scored[0].ts,
        },
      });
    }

    return badges;
  }
}

// --- helpers ---

function numeric(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function lineageRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    status: r.status,
    created_at: r.created_at,
    generations_away: r.depth,
  };
}
