import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketIndexService, MarketTick } from '../market/market-index.service';

/**
 * Agent DNA — a behavioural fingerprint computed from what an agent actually
 * did, never from what it declared.
 *
 * The distinction matters and is the reason this is not a copy of
 * strategy_score: that factor asks "did conduct match the declared
 * strategy_type". DNA does not read strategy_type at all. Two agents both
 * registered `momentum` can behave quite differently, and an agent's label can
 * be wrong — the fingerprint describes the record either way.
 *
 * V1 is Foundation level (see docs/agent-dna.md). It is a hand-built feature
 * vector, not a learned embedding; Agent DNA 2.0 (roadmap May 2027) replaces
 * the features with something derived from the decision sequence itself.
 *
 * Deliberately isolated from the Scoring Engine: DNA describes, it does not
 * score, and nothing here feeds arcana_score in V1.
 */

/** Fingerprint dimension declared by the schema (§7). See FEATURE_COUNT. */
const VECTOR_DIMS = 256;

/**
 * How many of those dimensions carry a real measurement. The remainder are
 * zero.
 *
 * Zero padding is mathematically free for the only operation the column exists
 * to serve: cosine similarity ignores dimensions that are zero in both
 * operands, contributing to neither dot product nor norm. So similarity over
 * these 256-dim vectors is identical to similarity over the 8 real features.
 * Inventing 248 more features to "fill the space" would be noise dressed as
 * signal — the empty room is reserved for DNA 2.0, not padded with fiction.
 */
const FEATURE_COUNT = 8;

/**
 * Minimum decisions before an agent has a DNA at all. Same threshold as the
 * scoring engine's participation rule: below it there is conduct to describe
 * but not enough of it to characterise, and a zero vector would look like a
 * measurement rather than an absence.
 */
const MIN_DECISIONS = 5;

/**
 * Scale ceilings used to map an unbounded feature onto [-1, 1]. A value at the
 * ceiling maps to +1; the midpoint maps to 0. Chosen to match the ranges the
 * decision engine's own risk limits produce, so a typical agent lands in the
 * middle of the range rather than pinned at an edge.
 */
const TRADE_SIZE_CEILING = 0.5; // fraction of NAV committed by one trade
const VOL_CEILING = 0.05; // per-tick return stdev, per unit of exposure
const DRAWDOWN_CEILING = 0.2; // max drawdown, per unit of exposure

/**
 * A tick is called flat when the market moved less than this. Below it the
 * direction is noise, and bucketing noise as "up" or "down" would put half an
 * agent's record in a regime that was not really there.
 */
const FLAT_REGIME_THRESHOLD = 0.0015; // 0.15%

/** Defaults mirrored from the decision engine's riskLimitsFrom(). */
const DEFAULT_TRADE_SIZE_PCT = 0.2;
const DEFAULT_MAX_POSITION_PCT = 0.35;

export interface DnaFeatures {
  turnover: number;
  sellShare: number;
  exposure: number;
  concentration: number;
  tradeSizePct: number;
  trendAlignment: number;
  volPerExposure: number;
  drawdownPerExposure: number;
}

interface AgentTick {
  ts: Date;
  nav: number;
  cash: number;
  holdings: Record<string, number>;
  ref: string | null;
  action: string | null;
  symbol: string | null;
  quantity: number | null;
}

@Injectable()
export class DnaService {
  private readonly logger = new Logger(DnaService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketIndex: MarketIndexService,
  ) {}

  // -------------------------------------------------------------------------
  // Batch
  // -------------------------------------------------------------------------

  /** Recompute DNA for every agent that has competed enough to have one. */
  async computeAll(): Promise<{ computed: number; skipped: number }> {
    const market = await this.marketIndex.load();

    const rows: Array<{ agent_id: string; n: string }> = await this.db.query(
      `SELECT agent_id, COUNT(*) AS n FROM decisions GROUP BY agent_id`,
    );

    let computed = 0;
    let skipped = 0;
    for (const row of rows) {
      if (Number(row.n) < MIN_DECISIONS) {
        skipped++;
        continue;
      }
      try {
        await this.computeForAgent(row.agent_id, market);
        computed++;
      } catch (e) {
        this.logger.error(`dna for agent ${row.agent_id}: ${e}`);
        skipped++;
      }
    }
    this.logger.log(`agent DNA batch: ${computed} computed, ${skipped} skipped`);
    return { computed, skipped };
  }

  private async computeForAgent(
    agentId: string,
    market: Map<string, MarketTick>,
  ): Promise<void> {
    const ticks = await this.loadAgentTicks(agentId);
    if (ticks.length === 0) return;

    const limits = await this.loadRiskLimits(agentId);
    const features = this.deriveFeatures(ticks, market);
    const risk = this.deriveRiskPersonality(features, ticks, limits);
    const regimes = this.deriveRegimeStrengths(ticks, market);
    const vector = this.toVector(features);

    await this.db.query(
      `INSERT INTO agent_dna (agent_id, strategy_fingerprint, risk_personality, regime_strengths, computed_at)
       VALUES ($1, $2::vector, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (agent_id) DO UPDATE SET
         strategy_fingerprint = EXCLUDED.strategy_fingerprint,
         risk_personality     = EXCLUDED.risk_personality,
         regime_strengths     = EXCLUDED.regime_strengths,
         computed_at          = EXCLUDED.computed_at`,
      [
        agentId,
        `[${vector.join(',')}]`,
        JSON.stringify({ ...risk, features }),
        JSON.stringify(regimes),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Feature derivation
  // -------------------------------------------------------------------------

  private deriveFeatures(
    ticks: AgentTick[],
    market: Map<string, MarketTick>,
  ): DnaFeatures {
    let buys = 0;
    let sells = 0;
    let exposureSum = 0;
    let exposureTicks = 0;
    let concentrationSum = 0;
    let concentrationTicks = 0;
    let tradeSizeSum = 0;
    let tradeCount = 0;
    let alignmentSum = 0;
    let alignmentCount = 0;

    for (const t of ticks) {
      if (t.action === 'buy') buys++;
      if (t.action === 'sell') sells++;

      if (t.nav > 0) {
        exposureSum += Math.max(0, (t.nav - t.cash) / t.nav);
        exposureTicks++;
      }

      const prices = t.ref ? market.get(t.ref)?.prices : undefined;

      // Concentration: Herfindahl index over position VALUES, normalised so
      // an even split scores 0 and everything-in-one-symbol scores 1. Ticks
      // holding nothing are skipped rather than counted as concentrated —
      // holding no position is not a concentrated position.
      if (prices) {
        const values = Object.entries(t.holdings)
          .map(([sym, qty]) => qty * (prices[sym] ?? 0))
          .filter((v) => v > 0);
        const total = values.reduce((a, b) => a + b, 0);
        if (total > 0 && values.length > 0) {
          const hhi = values.reduce((acc, v) => acc + (v / total) ** 2, 0);
          const floor = 1 / values.length;
          concentrationSum +=
            values.length > 1 ? (hhi - floor) / (1 - floor) : 1;
          concentrationTicks++;
        }
      }

      // Entry size, as a fraction of the book at the moment of the trade.
      //
      // BUYS ONLY. A sell exits the whole position, so averaging the two
      // conflates entry sizing with exit sizing and produces a number larger
      // than any limit the agent was configured with — risk_budget_utilisation
      // read 1.4x against a limit the agent had not actually breached. Exit
      // behaviour is already carried by sellShare.
      if (t.action === 'buy' && t.quantity != null && t.symbol && prices && t.nav > 0) {
        const price = prices[t.symbol];
        if (price > 0) {
          tradeSizeSum += (t.quantity * price) / t.nav;
          tradeCount++;
        }
      }

      // Trend alignment: did it buy into strength or into weakness? +1 for a
      // buy after an up tick or a sell after a down tick (trend-following),
      // -1 for the opposite (contrarian). This is the feature that separates
      // momentum from mean reversion — they trade at similar rates and hold
      // similar exposure, and differ mainly in direction.
      if ((t.action === 'buy' || t.action === 'sell') && t.ref) {
        const mkt = market.get(t.ref);
        if (mkt && Math.abs(mkt.marketReturn) > FLAT_REGIME_THRESHOLD) {
          const marketDir = Math.sign(mkt.marketReturn);
          const tradeDir = t.action === 'buy' ? 1 : -1;
          alignmentSum += marketDir * tradeDir;
          alignmentCount++;
        }
      }
    }

    const decisions = ticks.length;
    const trades = buys + sells;
    const exposure = exposureTicks > 0 ? exposureSum / exposureTicks : 0;

    const navs = ticks.map((t) => t.nav).filter((n) => n > 0);
    const returns: number[] = [];
    for (let i = 1; i < navs.length; i++) {
      if (navs[i - 1] > 0) returns.push((navs[i] - navs[i - 1]) / navs[i - 1]);
    }
    const exposureDivisor = Math.max(exposure, 0.02);

    return {
      turnover: decisions > 0 ? trades / decisions : 0,
      sellShare: trades > 0 ? sells / trades : 0,
      exposure,
      concentration:
        concentrationTicks > 0 ? concentrationSum / concentrationTicks : 0,
      tradeSizePct: tradeCount > 0 ? tradeSizeSum / tradeCount : 0,
      trendAlignment: alignmentCount > 0 ? alignmentSum / alignmentCount : 0,
      volPerExposure: stddev(returns) / exposureDivisor,
      drawdownPerExposure: maxDrawdown(navs) / exposureDivisor,
    };
  }

  /**
   * Map the features onto the fingerprint.
   *
   * Every component is centred on 0 rather than running 0..1. With all-positive
   * components every vector would sit in the same orthant and cosine similarity
   * would read high for agents that behave nothing alike; centring lets a
   * high-turnover low-exposure agent point in a genuinely different direction
   * from a low-turnover high-exposure one.
   */
  private toVector(f: DnaFeatures): number[] {
    const v = new Array<number>(VECTOR_DIMS).fill(0);
    v[0] = centre(f.turnover);
    v[1] = centre(f.sellShare);
    v[2] = centre(f.exposure);
    v[3] = centre(f.concentration);
    v[4] = centre(Math.min(f.tradeSizePct, TRADE_SIZE_CEILING) / TRADE_SIZE_CEILING);
    v[5] = clamp(f.trendAlignment, -1, 1); // already signed
    v[6] = centre(Math.min(f.volPerExposure, VOL_CEILING) / VOL_CEILING);
    v[7] = centre(Math.min(f.drawdownPerExposure, DRAWDOWN_CEILING) / DRAWDOWN_CEILING);
    return v.map((x) => round4(x));
  }

  private deriveRiskPersonality(
    f: DnaFeatures,
    ticks: AgentTick[],
    limits: { tradeSizePct: number; maxPositionPct: number },
  ) {
    let maxExposure = 0;
    for (const t of ticks) {
      if (t.nav > 0) {
        maxExposure = Math.max(maxExposure, (t.nav - t.cash) / t.nav);
      }
    }
    return {
      avg_exposure: round4(f.exposure),
      max_exposure: round4(maxExposure),
      volatility_per_exposure: round4(f.volPerExposure),
      max_drawdown_per_exposure: round4(f.drawdownPerExposure),
      avg_trade_size_pct: round4(f.tradeSizePct),
      position_concentration: round4(f.concentration),
      // How boldly the agent uses the allowance it was configured with. ~1.0
      // means it trades at its own declared limit; well under 1.0 means it is
      // more cautious than its risk_profile permits.
      risk_budget_utilisation:
        limits.tradeSizePct > 0
          ? round4(f.tradeSizePct / limits.tradeSizePct)
          : null,
      configured_trade_size_pct: limits.tradeSizePct,
      configured_max_position_pct: limits.maxPositionPct,
    };
  }

  /**
   * Descriptive only: how the agent fared while the market was rising, falling
   * or flat. Computed post-hoc by bucketing ticks on the market's own move.
   *
   * This is NOT the market-regime classifier on the Mar 2027 roadmap, and it
   * is NOT regime_score. Nothing here reaches the Scoring Engine.
   */
  private deriveRegimeStrengths(
    ticks: AgentTick[],
    market: Map<string, MarketTick>,
  ) {
    const buckets: Record<string, { ticks: number; agent: number; mkt: number }> = {
      up: { ticks: 0, agent: 1, mkt: 1 },
      down: { ticks: 0, agent: 1, mkt: 1 },
      flat: { ticks: 0, agent: 1, mkt: 1 },
    };

    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1];
      const cur = ticks[i];
      if (!cur.ref || !prev.ref || prev.nav <= 0) continue;

      // BOTH ends must have market data. Skipping only the unpriced tick would
      // leave the next NAV change spanning the gap — several ticks of movement
      // attributed to one market move, in whichever bucket that move landed.
      // Observed: a flat bucket reporting +8% while the market went nowhere.
      const mkt = market.get(cur.ref);
      if (!mkt || !market.has(prev.ref)) continue;

      const label =
        Math.abs(mkt.marketReturn) <= FLAT_REGIME_THRESHOLD
          ? 'flat'
          : mkt.marketReturn > 0
            ? 'up'
            : 'down';

      const agentReturn = (cur.nav - prev.nav) / prev.nav;
      buckets[label].ticks++;
      buckets[label].agent *= 1 + agentReturn;
      buckets[label].mkt *= 1 + mkt.marketReturn;
    }

    const out: Record<string, unknown> = {};
    for (const [label, b] of Object.entries(buckets)) {
      out[label] = {
        ticks: b.ticks,
        agent_return_pct: b.ticks > 0 ? round4((b.agent - 1) * 100) : null,
        market_return_pct: b.ticks > 0 ? round4((b.mkt - 1) * 100) : null,
      };
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------

  /**
   * One row per portfolio snapshot, paired with the decision that produced it.
   *
   * The two timestamps differ by milliseconds — the engine writes the decision
   * and then the snapshot — so this matches the most recent decision within a
   * short window rather than joining on equality.
   */
  private async loadAgentTicks(agentId: string): Promise<AgentTick[]> {
    const rows = await this.db.query(
      `SELECT ps.ts, ps.nav::float8 AS nav, ps.cash::float8 AS cash, ps.holdings,
              d.market_snapshot_ref, d.action, d.symbol, d.quantity::float8 AS quantity
       FROM portfolio_snapshots ps
       JOIN portfolios p ON p.id = ps.portfolio_id
       LEFT JOIN LATERAL (
         SELECT market_snapshot_ref, action, symbol, quantity
         FROM decisions
         WHERE agent_id = p.agent_id
           AND ts BETWEEN ps.ts - interval '5 seconds' AND ps.ts
         ORDER BY ts DESC
         LIMIT 1
       ) d ON true
       WHERE p.agent_id = $1
         AND p.season_id = (
           -- Scope to the agent's MOST RECENT season.
           --
           -- Before the vendor switchover this read an agent's entire history,
           -- which was right while there was only ever one market. It is wrong
           -- now: Season 1 ran on simulator prices and Season 2 runs on real
           -- ones, so an unscoped fingerprint would average conduct in two
           -- different worlds and present the mean as a measurement. The
           -- simulator caveat then becomes unremovable, because part of the
           -- number really would still come from the simulator.
           --
           -- Latest by season start, not by portfolio insertion: the season is
           -- what defines the market, and a portfolio created late in an old
           -- season is still that season's.
           SELECT p2.season_id FROM portfolios p2
           JOIN seasons s2 ON s2.id = p2.season_id
           WHERE p2.agent_id = $1
           ORDER BY s2.start_at DESC
           LIMIT 1
         )
       ORDER BY ps.ts ASC`,
      [agentId],
    );

    return rows.map((r: any) => ({
      ts: r.ts,
      nav: Number(r.nav) || 0,
      cash: Number(r.cash) || 0,
      holdings: (r.holdings ?? {}) as Record<string, number>,
      ref: r.market_snapshot_ref ?? null,
      action: r.action ?? null,
      symbol: r.symbol ?? null,
      quantity: r.quantity != null ? Number(r.quantity) : null,
    }));
  }

  /** The agent's own configured limits, for risk_budget_utilisation. */
  private async loadRiskLimits(agentId: string) {
    const rows = await this.db.query(
      `SELECT risk_profile FROM agents WHERE id = $1`,
      [agentId],
    );
    const profile = (rows[0]?.risk_profile ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = Number(profile[k]);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return null;
    };
    return {
      tradeSizePct:
        pick('trade_size_pct', 'tradeSizePct', 'max_risk_per_trade', 'maxRiskPerTrade') ??
        DEFAULT_TRADE_SIZE_PCT,
      maxPositionPct:
        pick('max_position_pct', 'maxPositionPct') ?? DEFAULT_MAX_POSITION_PCT,
    };
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /** GET /v1/agents/:id/dna — human-readable summary, not 256 raw numbers. */
  async getDna(agentId: string) {
    const rows = await this.db.query(
      `SELECT d.agent_id, a.name AS agent_name, a.strategy_type,
              d.risk_personality, d.regime_strengths, d.computed_at
       FROM agent_dna d JOIN agents a ON a.id = d.agent_id
       WHERE d.agent_id = $1`,
      [agentId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(
        `No DNA for agent ${agentId}: it has fewer than ${MIN_DECISIONS} recorded decisions, ` +
          `so there is not enough conduct to characterise`,
      );
    }
    const row = rows[0];
    const { features, ...risk } = row.risk_personality ?? {};

    return {
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      // Included for context only — the fingerprint is derived from conduct and
      // never reads this. A mismatch between the two is itself informative.
      declared_strategy_type: row.strategy_type,
      computed_at: row.computed_at,
      fingerprint: {
        dimensions: VECTOR_DIMS,
        features_used: FEATURE_COUNT,
        features: features ?? null,
        summary: features ? describe(features as DnaFeatures) : null,
      },
      risk_personality: risk,
      regime_strengths: row.regime_strengths,
    };
  }

  /**
   * GET /v1/agents/:id/dna/similar — nearest behavioural neighbours.
   *
   * This is what the VECTOR column is for. Cosine distance (`<=>`) over the
   * fingerprint answers "which agents behave like this one" in a single index
   * lookup, which a JSONB blob of the same numbers could not.
   */
  async similar(agentId: string, limit: number) {
    const rows = await this.db.query(
      `SELECT a.id AS agent_id, a.name AS agent_name, a.strategy_type,
              1 - (d.strategy_fingerprint <=> ref.strategy_fingerprint) AS similarity
       FROM agent_dna d
       JOIN agents a ON a.id = d.agent_id
       CROSS JOIN (SELECT strategy_fingerprint FROM agent_dna WHERE agent_id = $1) ref
       WHERE d.agent_id <> $1
       ORDER BY d.strategy_fingerprint <=> ref.strategy_fingerprint ASC
       LIMIT $2`,
      [agentId, limit],
    );
    if (rows.length === 0) {
      // Either the agent has no DNA, or it is the only agent that does.
      await this.getDna(agentId); // throws the explanatory 404 when absent
    }
    return {
      agent_id: agentId,
      neighbours: rows.map((r: any) => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        declared_strategy_type: r.strategy_type,
        similarity: round4(Number(r.similarity)),
      })),
    };
  }
}

// --- helpers ---

/** Map a 0..1 feature onto -1..1 so vectors can point in different directions. */
function centre(v: number): number {
  return clamp(v, 0, 1) * 2 - 1;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varc = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(varc);
}

function maxDrawdown(navs: number[]): number {
  let peak = navs[0] ?? 0;
  let worst = 0;
  for (const v of navs) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

/** A plain-language reading of the fingerprint, for the profile surface. */
function describe(f: DnaFeatures): string[] {
  const out: string[] = [];
  out.push(
    f.turnover >= 0.5
      ? 'trades on most ticks'
      : f.turnover >= 0.15
        ? 'trades selectively'
        : 'rarely trades',
  );
  out.push(
    f.exposure >= 0.6
      ? 'keeps most of the book invested'
      : f.exposure >= 0.25
        ? 'holds a partial position'
        : 'sits mostly in cash',
  );
  if (Math.abs(f.trendAlignment) >= 0.2) {
    out.push(
      f.trendAlignment > 0
        ? 'trades with the move (trend-following)'
        : 'trades against the move (contrarian)',
    );
  } else {
    out.push('shows no consistent direction relative to price moves');
  }
  out.push(
    f.concentration >= 0.5 ? 'concentrates in few symbols' : 'spreads across symbols',
  );
  return out;
}
