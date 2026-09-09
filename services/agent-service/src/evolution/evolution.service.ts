import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketIndexService } from '../market/market-index.service';

/**
 * Agent Evolution — the V1→V2→V3 chain, and what changed between versions.
 *
 * A read-model, like the Passport: nothing here is stored. The lineage lives in
 * `agents.parent_agent_id`, and each version's record is its own untouched rows
 * in decisions / portfolio_snapshots / score_snapshots. The old version's row
 * IS the config snapshot — no separate history table is needed, and adding one
 * would create a second version of the truth.
 *
 * The hard part is not assembling the numbers, it is refusing to over-claim
 * from them. See `comparability` below.
 */

/** Same participation threshold used by scoring, DNA and the Passport. */
const MIN_DECISIONS = 5;

@Injectable()
export class EvolutionService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketIndex: MarketIndexService,
  ) {}

  /**
   * GET /v1/agents/:id/evolution — the whole lineage this agent belongs to,
   * plus a comparison of each version against the one before it.
   */
  async getEvolution(agentId: string) {
    const root = await this.rootOf(agentId);
    const chain = await this.chainFrom(root);
    const market = await this.marketIndex.load();

    const versions = [];
    for (const a of chain) {
      versions.push(await this.versionRecord(a, market));
    }

    const comparisons = [];
    for (let i = 1; i < versions.length; i++) {
      comparisons.push(
        await this.compare(versions[i - 1], versions[i]),
      );
    }

    return {
      agent_id: agentId,
      lineage_root: root,
      versions,
      comparisons,
      // Stated once, at the top, because every number below is subject to it.
      caveat:
        'Versions compete in different periods and therefore in different market conditions. ' +
        'A higher score is not by itself evidence of a better agent. Each version carries the ' +
        'market return over its own window, and excess_return_pct is the cheap correction for it.',
    };
  }

  /** Walk up to the oldest ancestor so the whole chain is returned, not a tail. */
  private async rootOf(agentId: string): Promise<string> {
    const rows = await this.db.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_agent_id, 0 AS depth FROM agents WHERE id = $1
         UNION ALL
         SELECT a.id, a.parent_agent_id, up.depth + 1
         FROM agents a JOIN up ON a.id = up.parent_agent_id
       )
       SELECT id FROM up ORDER BY depth DESC LIMIT 1`,
      [agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    return rows[0].id;
  }

  /** The chain from the root downwards, oldest version first. */
  private async chainFrom(rootId: string) {
    return this.db.query(
      `WITH RECURSIVE down AS (
         SELECT id, name, version, status, strategy_type, risk_profile,
                asset_universe, parent_agent_id, created_at, 0 AS depth
         FROM agents WHERE id = $1
         UNION ALL
         SELECT a.id, a.name, a.version, a.status, a.strategy_type, a.risk_profile,
                a.asset_universe, a.parent_agent_id, a.created_at, down.depth + 1
         FROM agents a JOIN down ON a.parent_agent_id = down.id
       )
       SELECT * FROM down ORDER BY depth ASC, version ASC`,
      [rootId],
    );
  }

  /** Everything measurable about one version's run. */
  private async versionRecord(agent: any, market: Map<string, any>) {
    const stats = await this.db.query(
      `SELECT COUNT(*)::int AS decisions,
              COUNT(*) FILTER (WHERE action <> 'hold')::int AS trades
       FROM decisions WHERE agent_id = $1`,
      [agent.id],
    );
    const nav = await this.db.query(
      `SELECT COUNT(*)::int AS ticks, MIN(ps.ts) AS first_tick, MAX(ps.ts) AS last_tick,
              (ARRAY_AGG(ps.nav ORDER BY ps.ts ASC))[1] AS first_nav,
              (ARRAY_AGG(ps.nav ORDER BY ps.ts DESC))[1] AS last_nav,
              AVG(ps.cash / NULLIF(ps.nav, 0)) AS avg_cash_ratio
       FROM portfolio_snapshots ps
       JOIN portfolios p ON p.id = ps.portfolio_id
       WHERE p.agent_id = $1`,
      [agent.id],
    );
    const score = await this.db.query(
      `SELECT COUNT(*)::int AS runs,
              MAX(arcana_score) AS peak_arcana,
              (ARRAY_AGG(arcana_score ORDER BY ts DESC))[1] AS latest_arcana,
              AVG(performance_score) AS avg_performance,
              AVG(risk_score) AS avg_risk,
              AVG(consistency_score) AS avg_consistency,
              AVG(strategy_score) AS avg_strategy
       FROM score_snapshots WHERE agent_id = $1 AND arcana_score IS NOT NULL`,
      [agent.id],
    );

    const s = stats[0] ?? { decisions: 0, trades: 0 };
    const n = nav[0] ?? {};
    const sc = score[0] ?? {};

    const firstNav = num(n.first_nav);
    const lastNav = num(n.last_nav);
    const agentReturnPct =
      firstNav && lastNav && firstNav > 0
        ? round4(((lastNav - firstNav) / firstNav) * 100)
        : null;
    const marketReturnPct = this.marketIndex.compoundedReturnPct(
      market,
      n.first_tick ?? null,
      n.last_tick ?? null,
    );

    return {
      agent_id: agent.id,
      version: agent.version,
      status: agent.status,
      config: {
        strategy_type: agent.strategy_type,
        risk_profile: agent.risk_profile,
        asset_universe: agent.asset_universe,
      },
      created_at: agent.created_at,
      ranked: s.decisions >= MIN_DECISIONS,
      window: { first_tick: n.first_tick ?? null, last_tick: n.last_tick ?? null },
      activity: {
        ticks: n.ticks ?? 0,
        decisions: s.decisions,
        trades: s.trades,
        turnover: s.decisions > 0 ? round4(s.trades / s.decisions) : null,
        avg_exposure:
          n.avg_cash_ratio != null ? round4(1 - Number(n.avg_cash_ratio)) : null,
      },
      performance: {
        first_nav: firstNav,
        last_nav: lastNav,
        agent_return_pct: agentReturnPct,
        // What the market itself did over the SAME window.
        market_return_pct: marketReturnPct,
        // The cheap correction: how much of the result was the agent rather
        // than the weather. Not a risk-adjusted alpha, and not presented as one.
        excess_return_pct:
          agentReturnPct != null && marketReturnPct != null
            ? round4(agentReturnPct - marketReturnPct)
            : null,
      },
      scores: {
        runs: sc.runs ?? 0,
        peak_arcana: num(sc.peak_arcana),
        latest_arcana: num(sc.latest_arcana),
        avg_performance: num(sc.avg_performance),
        avg_risk: num(sc.avg_risk),
        avg_consistency: num(sc.avg_consistency),
        avg_strategy: num(sc.avg_strategy),
      },
    };
  }

  /**
   * One version against the one before it.
   *
   * Deliberately reports deltas and never a verdict. The system does not say
   * "v2 is better" — it says what changed, what the market did in each window,
   * and whether the behaviour actually moved. Judging is the reader's job, and
   * the data here is not strong enough to take it from them: two versions never
   * meet the same ticks, so no delta separates skill from conditions.
   */
  private async compare(before: any, after: any) {
    const dna = await this.dnaDistance(before.agent_id, after.agent_id);

    return {
      from_version: before.version,
      to_version: after.version,
      config_changed: this.configDiff(before.config, after.config),
      // The question this whole feature exists to answer: did the agent's
      // conduct actually change, or was the config edited to no effect?
      behaviour: dna,
      deltas: {
        latest_arcana: delta(before.scores.latest_arcana, after.scores.latest_arcana),
        avg_performance: delta(before.scores.avg_performance, after.scores.avg_performance),
        avg_risk: delta(before.scores.avg_risk, after.scores.avg_risk),
        avg_consistency: delta(before.scores.avg_consistency, after.scores.avg_consistency),
        turnover: delta(before.activity.turnover, after.activity.turnover),
        avg_exposure: delta(before.activity.avg_exposure, after.activity.avg_exposure),
        agent_return_pct: delta(
          before.performance.agent_return_pct,
          after.performance.agent_return_pct,
        ),
        // The one worth reading first: it already nets out each period's market.
        excess_return_pct: delta(
          before.performance.excess_return_pct,
          after.performance.excess_return_pct,
        ),
      },
      market_context: {
        before: {
          window: before.window,
          market_return_pct: before.performance.market_return_pct,
        },
        after: {
          window: after.window,
          market_return_pct: after.performance.market_return_pct,
        },
        comparable: this.comparability(before, after),
      },
    };
  }

  /**
   * Cosine similarity between the two versions' DNA fingerprints.
   *
   * This is the part that cannot be faked by editing config: a version whose
   * fingerprint is nearly identical to its parent's did not change behaviour,
   * whatever its risk_profile now says.
   */
  private async dnaDistance(beforeId: string, afterId: string) {
    const rows = await this.db.query(
      `SELECT 1 - (a.strategy_fingerprint <=> b.strategy_fingerprint) AS similarity
       FROM agent_dna a, agent_dna b
       WHERE a.agent_id = $1 AND b.agent_id = $2`,
      [beforeId, afterId],
    );
    if (rows.length === 0) {
      return {
        dna_similarity: null,
        reading: 'not comparable — one or both versions have no DNA yet',
      };
    }
    const sim = round4(Number(rows[0].similarity));
    return {
      dna_similarity: sim,
      reading:
        sim >= 0.95
          ? 'behaviour essentially unchanged — the config moved, the conduct did not'
          : sim >= 0.7
            ? 'behaviour shifted, same broad character'
            : sim >= 0
              ? 'behaviour clearly different'
              : 'behaviour inverted — the versions now act in opposing directions',
    };
  }

  /** Which config fields actually differ, with both values. */
  private configDiff(before: any, after: any) {
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['strategy_type', 'asset_universe']) {
      if (before[key] !== after[key]) diff[key] = { from: before[key], to: after[key] };
    }
    const b = before.risk_profile ?? {};
    const a = after.risk_profile ?? {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
        diff[`risk_profile.${key}`] = { from: b[key] ?? null, to: a[key] ?? null };
      }
    }
    return { changed: Object.keys(diff).length > 0, fields: diff };
  }

  /**
   * An honest note on whether the two runs can be compared at all, rather than
   * a number implying they can.
   */
  private comparability(before: any, after: any): string {
    if (!before.ranked || !after.ranked) {
      return 'not comparable: one version is below the participation threshold';
    }
    const mb = before.performance.market_return_pct;
    const ma = after.performance.market_return_pct;
    if (mb == null || ma == null) {
      return 'market context unavailable for one window';
    }
    const gap = Math.abs(ma - mb);
    if (gap >= 5) {
      return `weak: the market moved ${round4(mb)}% in one window and ${round4(ma)}% in the other — conditions differ more than most agent effects`;
    }
    if (before.activity.ticks < 20 || after.activity.ticks < 20) {
      return 'weak: one version has fewer than 20 ticks, too short to characterise';
    }
    return 'reasonable: comparable window lengths and similar market conditions';
  }
}

// --- helpers ---

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? round4(n) : null;
}

function delta(before: number | null, after: number | null) {
  if (before == null || after == null) return { before, after, change: null };
  return { before, after, change: round4(after - before) };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
