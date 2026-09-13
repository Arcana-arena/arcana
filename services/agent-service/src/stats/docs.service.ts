import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MIN_DECISIONS, REGIME_WEIGHT_NOTE, SCORE_WEIGHTS, STRATEGY_NOTE } from '../common/ranking';

/**
 * Every number the documentation quotes, read from the values in force.
 *
 * WHY DOCUMENTATION NEEDS AN ENDPOINT. A docs page that states "seven
 * components, weighted 0.25 / 0.20 / …" is a copy of the scoring engine written
 * in prose, and prose does not get recompiled. The weights on this platform are
 * .35 / .25 / .15 / .10 / .10 / .05 with strategy as a MULTIPLIER rather than a
 * term — different from the design document in both the figures and the shape —
 * and a page repeating the design document would be confidently wrong about the
 * thing it exists to explain.
 *
 * So the prose is authored and the figures are read. Anything with a number in
 * it comes from here, and here reads the same constants the engine and the
 * leaderboard read.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no prize pool, no minimum days live, no
 * NAV floor and no per-creator cap, because nothing on this platform holds or
 * enforces one. They are listed as unencoded rules by /v1/seasons/:id/rules
 * rather than given plausible values here.
 */
@Injectable()
export class DocsService {
  private readonly arcaUrl: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://127.0.0.1:3004';
  }

  async parameters() {
    const [season, symbols, deciders, terms] = await Promise.all([
      this.db.query(
        `SELECT id::text, name, universe, start_at, end_at, access_tier, ruleset
           FROM seasons
          WHERE start_at <= now() AND end_at > now()
          ORDER BY start_at DESC LIMIT 1`,
      ),
      this.db.query(
        `SELECT DISTINCT symbol FROM decisions_counted
          WHERE symbol IS NOT NULL AND symbol <> '' ORDER BY symbol`,
      ),
      // The vocabulary the decision log actually uses, so the glossary in the
      // docs describes this platform rather than a generic one.
      this.db.query(
        `SELECT decider, count(*)::int AS decisions
           FROM decisions_counted WHERE decider IS NOT NULL
          GROUP BY decider ORDER BY count(*) DESC`,
      ),
      this.terms(),
    ]);

    const weights = Object.entries(SCORE_WEIGHTS).map(([key, weight]) => ({
      key,
      weight,
      // REGIME IS NAMED AS MEASURING NOTHING, in the same row as its weight.
      // A weights table that lists it beside performance and risk implies it
      // discriminates between agents, and it does not: the engine writes the
      // same neutral value for every one of them.
      measures: key === 'regime' ? false : true,
      note: key === 'regime' ? REGIME_WEIGHT_NOTE : null,
    }));
    const sum = weights.reduce((a, w) => a + w.weight, 0);

    return {
      scoring: {
        weights,
        // Printed rather than asserted. If the engine's weights ever stop
        // summing to one, the docs page shows it instead of hiding it behind a
        // table that looks tidy.
        weights_sum: Number(sum.toFixed(4)),
        weights_sum_note:
          Math.abs(sum - 1) < 1e-9
            ? 'The weighted terms sum to 1.'
            : `The weighted terms sum to ${sum.toFixed(4)}, not 1. That is what the engine is doing.`,
        strategy_note: STRATEGY_NOTE,
        strategy_is_a_term: false,
        min_decisions_to_rank: MIN_DECISIONS,
        withheld_not_low:
          'An agent below the decision threshold has NO score. The engine stores NULL for the ' +
          'composite, risk and consistency figures rather than a low number, and every surface that ' +
          'shows a dash for it also shows the reason.',
        source: 'services/scoring-engine/internal/engine/score.go, mirrored in common/ranking.ts and held to it by leaderboard-verify',
      },
      season: season[0]
        ? {
            id: season[0].id,
            name: season[0].name,
            universe: season[0].universe,
            start_at: new Date(season[0].start_at).toISOString(),
            end_at: new Date(season[0].end_at).toISOString(),
            access_tier: season[0].access_tier,
            ruleset: season[0].ruleset ?? {},
          }
        : null,
      season_note: season[0]
        ? null
        : 'No season is running right now, so the figures that belong to a season are not stated.',
      symbols: symbols.map((s: { symbol: string }) => s.symbol),
      symbols_note:
        'Symbols this platform has actually recorded a decision on. Not a list of what is permitted — ' +
        'the two are different claims.',
      deciders: deciders.map((d: { decider: string; decisions: number }) => ({
        decider: d.decider,
        decisions: Number(d.decisions),
      })),
      deciders_note:
        'Who made each decision. `protective` does not mean a level fired: most protective rows are a ' +
        'level that was crossed and an exit that was NOT taken.',
      subscription: terms,
      as_of: new Date().toISOString(),
    };
  }

  /**
   * The subscription terms, asked of arca-service rather than restated.
   *
   * The term length, the grace window, the claim deadline and the confirmation
   * depth are enforced there. A copy here would be a second set of numbers that
   * agree until one of them is changed — and the one a buyer reads would be the
   * copy.
   */
  private async terms() {
    try {
      const res = await fetch(`${this.arcaUrl}/v1/arca/terms`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        return { available: false, reason: `arca-service answered ${res.status}` };
      }
      return { available: true, reason: null, ...(await res.json()) };
    } catch (e) {
      return {
        available: false,
        reason: `arca-service could not be reached (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }
}
