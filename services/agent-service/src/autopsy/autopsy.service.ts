import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketIndexService, MarketTick } from '../market/market-index.service';

/**
 * Agent Autopsy — why an agent performed the way it did, from its own record.
 *
 * A read-model over `decisions`, `portfolio_snapshots`, `market_snapshots` and
 * `agent_dna`. It explains the score; it never changes it, and nothing here
 * reaches the Scoring Engine.
 *
 * THE RULE THIS FILE IS BUILT AROUND: every statement must be traceable to
 * specific rows. An autopsy is the easiest place in this platform to smuggle in
 * a narrative that sounds authoritative and is not supported by anything — so
 * this returns measurements and the evidence behind them, and refuses the
 * interpretive leap.
 *
 *   "bought at the 82nd percentile of the surrounding price range"  — a fact
 *   "the agent misread the market"                                  — not ours
 *
 * Small samples are labelled rather than quietly averaged, and sections with
 * nothing to measure say so instead of returning zeros that read like findings.
 *
 * Placement: this lives in agent-service rather than the Scoring Engine that
 * §2.3 assigns it to. Following §2.3 would mean a third Go implementation of
 * "what the market did" alongside MarketIndexService, plus duplicating the
 * tick/decision pairing and reading agent_dna from Go. Keeping the analysis
 * next to its data beat following the document into duplication.
 */

/** Same participation threshold as scoring, DNA, passport and evolution. */
const MIN_DECISIONS = 5;

/**
 * Trades needed before timing is characterised at all. Two trades can look
 * like impeccable or catastrophic timing purely by luck, and a confident
 * number from a sample that small is a lie with a decimal point.
 */
const MIN_TRADES_FOR_TIMING = 5;

/** Ticks either side of a trade used to place its price in local context. */
const TIMING_WINDOW = 5;

interface AgentTick {
  ts: Date;
  nav: number;
  cash: number;
  holdings: Record<string, number>;
  ref: string | null;
  action: string | null;
  symbol: string | null;
  quantity: number | null;
  rationale: string | null;
}

@Injectable()
export class AutopsyService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketIndex: MarketIndexService,
  ) {}

  async getAutopsy(agentId: string) {
    const agent = await this.loadAgent(agentId);
    const ticks = await this.loadTicks(agentId);
    const market = await this.marketIndex.load();
    const series = [...market.values()];
    const indexOfRef = new Map(series.map((t, i) => [t.ref, i]));

    const decisions = ticks.filter((t) => t.action != null).length;
    const trades = ticks.filter((t) => t.action === 'buy' || t.action === 'sell');

    if (decisions < MIN_DECISIONS) {
      return {
        agent: { id: agent.id, name: agent.name, version: agent.version, status: agent.status },
        analysed: false,
        reason: `Only ${decisions} recorded decisions; ${MIN_DECISIONS} are needed before any ` +
          'analysis would describe behaviour rather than noise.',
        decisions,
        // The exclusions still apply and are still worth stating.
        not_analysed: this.notAnalysed(),
      };
    }

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        status: agent.status,
        strategy_type: agent.strategy_type,
      },
      analysed: true,
      summary: this.summary(ticks, decisions, trades.length),
      allocation: this.allocation(ticks, market),
      decision_timing: this.timing(trades, series, indexOfRef),
      risk: this.risk(ticks),
      volatility: this.volatility(ticks, market, trades.length),
      market_regime: await this.regime(agentId),
      historical_decisions: this.history(ticks),
      not_analysed: this.notAnalysed(),
      ...this.marketProvenance(ticks, market),
    };
  }

  /**
   * Which market these findings describe, and the caveat that follows from it.
   *
   * The caveat used to be a constant, because there was only ever one market and
   * it was a simulator. Now it is derived from the snapshots the analysis
   * actually read: real prices earn no caveat, simulator prices still earn the
   * full one, and a mixture earns the worst of the two rather than the average.
   *
   * Deriving it is the point. A hardcoded caveat is wrong the moment the data
   * changes and nobody remembers to edit it — and a stale caveat is not a
   * harmless leftover, it is a false statement about evidence.
   */
  private marketProvenance(ticks: AgentTick[], market: Map<string, MarketTick>) {
    const sources = [
      ...new Set(
        ticks
          .map((t) => (t.ref ? market.get(t.ref)?.source : undefined))
          .filter((s): s is string => !!s),
      ),
    ].sort();

    const simulated = sources.includes('simulator');
    return {
      market_provenance: {
        sources,
        simulated,
      },
      caveat: simulated
        ? 'Some or all of the decisions analysed were made against a SIMULATOR whose trend ' +
          'behaviour ARCANA calibrated itself (docs/data-resets.md). Findings describe conduct ' +
          'in that market and do not carry to a real one.'
        : `Prices came from ${sources.join(', ') || 'the market data vendor'} — real market ` +
          'data. Findings describe conduct in the real market, within the limits listed under ' +
          'not_analysed.',
    };
  }

  // -------------------------------------------------------------------------

  private summary(ticks: AgentTick[], decisions: number, trades: number) {
    const navs = ticks.map((t) => t.nav).filter((n) => n > 0);
    return {
      ticks: ticks.length,
      decisions,
      trades,
      first_tick: ticks[0]?.ts ?? null,
      last_tick: ticks[ticks.length - 1]?.ts ?? null,
      first_nav: navs[0] ?? null,
      last_nav: navs[navs.length - 1] ?? null,
      return_pct:
        navs.length >= 2 && navs[0] > 0
          ? round4(((navs[navs.length - 1] - navs[0]) / navs[0]) * 100)
          : null,
    };
  }

  /**
   * Where the return came from — and what sitting in cash cost.
   *
   * Per-symbol P&L is exact: the position held at each tick multiplied by that
   * symbol's price change into the next tick. Cash drag is the counterfactual
   * "what the idle cash would have earned at market" — an estimate, and
   * labelled as one.
   */
  private allocation(ticks: AgentTick[], market: Map<string, MarketTick>) {
    const pnl: Record<string, number> = {};
    let cashDrag = 0;
    let cashSum = 0;
    let counted = 0;

    for (let i = 0; i < ticks.length - 1; i++) {
      const cur = ticks[i];
      const next = ticks[i + 1];
      if (!cur.ref || !next.ref) continue;
      const p0 = market.get(cur.ref)?.prices;
      const m1 = market.get(next.ref);
      if (!p0 || !m1) continue;

      for (const [sym, qty] of Object.entries(cur.holdings)) {
        const before = p0[sym];
        const after = m1.prices[sym];
        if (before > 0 && after > 0) {
          pnl[sym] = (pnl[sym] ?? 0) + qty * (after - before);
        }
      }

      cashDrag += cur.cash * m1.marketReturn;
      if (cur.nav > 0) {
        cashSum += cur.cash / cur.nav;
        counted++;
      }
    }

    const firstNav = ticks.find((t) => t.nav > 0)?.nav ?? 0;
    const bySymbol = Object.entries(pnl)
      .map(([symbol, amount]) => ({
        symbol,
        pnl: round2(amount),
        pct_of_starting_nav: firstNav > 0 ? round4((amount / firstNav) * 100) : null,
      }))
      .sort((a, b) => b.pnl - a.pnl);

    return {
      by_symbol: bySymbol,
      cash: {
        avg_cash_fraction: counted > 0 ? round4(cashSum / counted) : null,
        // Positive = the idle cash would have GAINED at market rate, so holding
        // it cost that much. Negative = cash sheltered the book from a fall.
        estimated_cash_drag: round2(cashDrag),
        pct_of_starting_nav: firstNav > 0 ? round4((cashDrag / firstNav) * 100) : null,
        method:
          'Counterfactual estimate: idle cash at each tick multiplied by the market index return ' +
          'into the next tick. It assumes the cash could have been deployed at the market rate, ' +
          'which the agent never attempted — an estimate, not a measured loss.',
        sign:
          'POSITIVE means the idle cash would have gained at market rate, so holding it cost that ' +
          'much. NEGATIVE means the market fell while the cash sat out, so staying in cash ' +
          'sheltered the book by that amount — a negative "drag" is a benefit, not a loss.',
      },
      evidence: {
        ticks_paired: ticks.length - 1,
        note: 'Per-symbol P&L is exact from held quantity x price change; only cash drag is estimated.',
      },
    };
  }

  /**
   * Did it trade near local peaks or local troughs?
   *
   * For each trade the execution price is placed in the range of the
   * surrounding ±5 ticks for that symbol: 0 means it traded at the lowest price
   * in the window, 100 the highest. A buy near 0 is well-timed; a sell near 100
   * is well-timed. Forward return over the following 5 ticks is reported
   * alongside, because a good entry price and a bad subsequent move are
   * different facts.
   *
   * Nothing here says the agent "predicted" anything. It says where its trades
   * landed in the price range that surrounded them.
   */
  private timing(
    trades: AgentTick[],
    series: MarketTick[],
    indexOfRef: Map<string, number>,
  ) {
    if (trades.length < MIN_TRADES_FOR_TIMING) {
      return {
        analysed: false,
        trades: trades.length,
        reason:
          trades.length === 0
            ? 'No trades recorded, so there is no timing to analyse. This is an absence of data, ' +
              'not a timing score of zero.'
            : `Only ${trades.length} trades; ${MIN_TRADES_FOR_TIMING} are needed before a timing ` +
              'figure would mean more than luck.',
      };
    }

    const scored: Array<{
      ts: Date;
      action: string;
      symbol: string;
      price: number;
      percentile: number | null;
      forward_return_pct: number | null;
      rationale: string | null;
    }> = [];

    for (const t of trades) {
      if (!t.ref || !t.symbol) continue;
      const idx = indexOfRef.get(t.ref);
      if (idx == null) continue;
      const price = series[idx].prices[t.symbol];
      if (!(price > 0)) continue;

      const lo = Math.max(0, idx - TIMING_WINDOW);
      const hi = Math.min(series.length - 1, idx + TIMING_WINDOW);
      const window: number[] = [];
      for (let i = lo; i <= hi; i++) {
        const p = series[i].prices[t.symbol];
        if (p > 0) window.push(p);
      }

      let percentile: number | null = null;
      if (window.length >= 3) {
        const below = window.filter((p) => p < price).length;
        percentile = round2((below / (window.length - 1)) * 100);
      }

      const fwdIdx = Math.min(series.length - 1, idx + TIMING_WINDOW);
      const fwdPrice = series[fwdIdx].prices[t.symbol];
      const forward =
        fwdIdx > idx && fwdPrice > 0 ? round4(((fwdPrice - price) / price) * 100) : null;

      scored.push({
        ts: t.ts,
        action: t.action as string,
        symbol: t.symbol,
        price,
        percentile,
        forward_return_pct: forward,
        rationale: t.rationale,
      });
    }

    const buys = scored.filter((s) => s.action === 'buy');
    const sells = scored.filter((s) => s.action === 'sell');

    return {
      analysed: true,
      trades: scored.length,
      window_ticks: TIMING_WINDOW,
      buys: {
        count: buys.length,
        avg_price_percentile: avg(buys.map((b) => b.percentile)),
        avg_forward_return_pct: avg(buys.map((b) => b.forward_return_pct)),
        reading:
          'Percentile 0 = bought at the lowest price in the surrounding window, 100 = the highest.',
      },
      sells: {
        count: sells.length,
        avg_price_percentile: avg(sells.map((s) => s.percentile)),
        avg_forward_return_pct: avg(sells.map((s) => s.forward_return_pct)),
        reading:
          'For a sell, a HIGH percentile means it sold near the top of the surrounding window.',
      },
      // Individual rows so any aggregate above can be traced to the trades
      // behind it, rationale included.
      best_entries: [...buys]
        .filter((b) => b.forward_return_pct != null)
        .sort((a, b) => (b.forward_return_pct as number) - (a.forward_return_pct as number))
        .slice(0, 3),
      worst_entries: [...buys]
        .filter((b) => b.forward_return_pct != null)
        .sort((a, b) => (a.forward_return_pct as number) - (b.forward_return_pct as number))
        .slice(0, 3),
    };
  }

  /** The deepest fall, when it happened, what was decided during it. */
  private risk(ticks: AgentTick[]) {
    const points = ticks.filter((t) => t.nav > 0);
    if (points.length < 2) {
      return { analysed: false, reason: 'Fewer than two NAV points; no drawdown to locate.' };
    }

    let peak = points[0];
    let peakIdx = 0;
    let worst = { depth: 0, peakIdx: 0, troughIdx: 0 };

    for (let i = 1; i < points.length; i++) {
      if (points[i].nav > peak.nav) {
        peak = points[i];
        peakIdx = i;
      }
      const depth = (peak.nav - points[i].nav) / peak.nav;
      if (depth > worst.depth) worst = { depth, peakIdx, troughIdx: i };
    }

    if (worst.depth === 0) {
      return { analysed: true, max_drawdown_pct: 0, note: 'NAV never fell below a prior peak.' };
    }

    const peakPoint = points[worst.peakIdx];
    const troughPoint = points[worst.troughIdx];

    // Recovery: the first tick after the trough that regains the old peak.
    let recoveredAt: Date | null = null;
    let recoveryTicks: number | null = null;
    for (let i = worst.troughIdx + 1; i < points.length; i++) {
      if (points[i].nav >= peakPoint.nav) {
        recoveredAt = points[i].ts;
        recoveryTicks = i - worst.troughIdx;
        break;
      }
    }

    const during = points
      .slice(worst.peakIdx, worst.troughIdx + 1)
      .filter((t) => t.action === 'buy' || t.action === 'sell');

    return {
      analysed: true,
      max_drawdown_pct: round4(worst.depth * 100),
      peak: { ts: peakPoint.ts, nav: round2(peakPoint.nav) },
      trough: { ts: troughPoint.ts, nav: round2(troughPoint.nav) },
      duration_ticks: worst.troughIdx - worst.peakIdx,
      recovered: recoveredAt != null,
      recovered_at: recoveredAt,
      recovery_ticks: recoveryTicks,
      decisions_during_drawdown: {
        trades: during.length,
        // Listed so the drawdown can be read against what the agent was doing,
        // WITHOUT asserting that these trades caused it.
        sample: during.slice(0, 5).map((t) => ({
          ts: t.ts,
          action: t.action,
          symbol: t.symbol,
          quantity: t.quantity,
          rationale: t.rationale,
        })),
        note:
          'These trades occurred inside the drawdown window. Co-occurrence is not causation and ' +
          'no causal claim is made here.',
      },
    };
  }

  /**
   * Whose volatility is it — the market's, or the agent's own trading?
   *
   * An agent holding 30% of its book cannot move more than 30% of the market's
   * volatility from price alone. Dividing its NAV volatility by exposure gives
   * the volatility per unit of market it actually took; comparing that with the
   * market's own volatility separates the tide from the rowing.
   */
  private volatility(ticks: AgentTick[], market: Map<string, MarketTick>, trades: number) {
    const navs = ticks.filter((t) => t.nav > 0);
    const agentReturns: number[] = [];
    const marketReturns: number[] = [];
    let exposureSum = 0;
    let exposureCount = 0;

    for (let i = 1; i < navs.length; i++) {
      if (navs[i - 1].nav > 0) {
        agentReturns.push((navs[i].nav - navs[i - 1].nav) / navs[i - 1].nav);
      }
      const m = navs[i].ref ? market.get(navs[i].ref as string) : undefined;
      if (m) marketReturns.push(m.marketReturn);
      if (navs[i].nav > 0) {
        exposureSum += Math.max(0, (navs[i].nav - navs[i].cash) / navs[i].nav);
        exposureCount++;
      }
    }

    const exposure = exposureCount > 0 ? exposureSum / exposureCount : 0;
    const agentVol = stddev(agentReturns);
    const marketVol = stddev(marketReturns);
    const perExposure = exposure > 0.02 ? agentVol / exposure : null;
    const ratio = perExposure != null && marketVol > 0 ? perExposure / marketVol : null;

    return {
      agent_nav_volatility: round6(agentVol),
      market_volatility: round6(marketVol),
      avg_exposure: round4(exposure),
      volatility_per_unit_exposure: perExposure != null ? round6(perExposure) : null,
      ratio_vs_market: ratio != null ? round4(ratio) : null,
      reading:
        ratio == null
          ? 'Exposure too small to attribute volatility.'
          : ratio > 1.15
            ? 'Per unit of exposure the book moved MORE than the market index did.'
            : ratio < 0.85
              ? 'Per unit of exposure the book moved LESS than the market index did.'
              : 'Per unit of exposure the book tracked the market index closely.',
      // The ratio measures a difference; it does not identify its cause. Two
      // candidates produce it — trading, and holding a mix that differs from
      // the equal-weighted index — and this measure cannot separate them.
      // Naming one would be the interpretive leap this analysis refuses.
      attribution:
        ratio == null
          ? null
          : trades === 0
            ? 'This agent made no trades in the period, so the difference cannot come from ' +
              'trading. What remains is position composition: a book weighted differently from ' +
              'the equal-weighted index moves differently from it.'
            : 'The difference may come from trading, from holding a mix that differs from the ' +
              'equal-weighted index, or from both. This measure does not separate them.',
    };
  }

  /** Reused from agent_dna, not recomputed. */
  private async regime(agentId: string) {
    const rows = await this.db.query(
      `SELECT regime_strengths, computed_at FROM agent_dna WHERE agent_id = $1`,
      [agentId],
    );
    if (rows.length === 0) {
      return { available: false, reason: 'No DNA computed for this agent yet.' };
    }
    return {
      available: true,
      source: 'agent_dna.regime_strengths (computed by the Agent DNA batch)',
      computed_at: rows[0].computed_at,
      ...rows[0].regime_strengths,
    };
  }

  /** Plain shape of the decision record over time. */
  private history(ticks: AgentTick[]) {
    const counts: Record<string, number> = { buy: 0, sell: 0, hold: 0 };
    let longestHold = 0;
    let run = 0;
    for (const t of ticks) {
      if (!t.action) continue;
      counts[t.action] = (counts[t.action] ?? 0) + 1;
      if (t.action === 'hold') {
        run++;
        longestHold = Math.max(longestHold, run);
      } else {
        run = 0;
      }
    }
    const total = counts.buy + counts.sell + counts.hold;
    return {
      actions: counts,
      turnover: total > 0 ? round4((counts.buy + counts.sell) / total) : null,
      longest_hold_streak_ticks: longestHold,
      symbols_traded: [
        ...new Set(ticks.filter((t) => t.symbol).map((t) => t.symbol as string)),
      ],
    };
  }

  /**
   * The sections the whitepaper names that this V1 does NOT provide, and why.
   *
   * Returned in the payload rather than buried in docs: a consumer reading the
   * response should be able to see what is missing without knowing what to
   * expect.
   */
  private notAnalysed() {
    return [
      {
        section: 'sector_rotation',
        reason:
          'The data blocker is gone — the universe is now 50 symbols across 11 GICS sectors and ' +
          'every snapshot quote carries its sector (services/market-data/universe/). What is ' +
          'missing is the analysis itself, which is Autopsy 2.0 work rather than a schema gap. ' +
          'It also needs enough real-market history for a rotation to be distinguishable from a ' +
          'few coincidental trades.',
      },
      {
        section: 'thesis_failure',
        reason:
          'decisions.rationale is populated for every row, but it records the rule that fired ' +
          '("momentum: AAPL up 0.26% since last tick"), not a forward-looking thesis. There is no ' +
          'claim about the future to test against the outcome, so testing one would mean ' +
          'inventing the thesis first.',
      },
    ];
  }

  // -------------------------------------------------------------------------

  private async loadAgent(agentId: string) {
    const rows = await this.db.query(
      `SELECT id, name, version, status, strategy_type FROM agents WHERE id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    return rows[0];
  }

  /** Same pairing DNA uses: a snapshot with the decision that produced it. */
  private async loadTicks(agentId: string): Promise<AgentTick[]> {
    const rows = await this.db.query(
      `SELECT ps.ts, ps.nav::float8 AS nav, ps.cash::float8 AS cash, ps.holdings,
              d.market_snapshot_ref, d.action, d.symbol, d.quantity::float8 AS quantity,
              d.rationale
       FROM portfolio_snapshots ps
       JOIN portfolios p ON p.id = ps.portfolio_id
       LEFT JOIN LATERAL (
         SELECT market_snapshot_ref, action, symbol, quantity, rationale
         FROM decisions
         WHERE agent_id = p.agent_id
           AND ts BETWEEN ps.ts - interval '5 seconds' AND ps.ts
         ORDER BY ts DESC LIMIT 1
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
      rationale: r.rationale ?? null,
    }));
  }
}

// --- helpers ---

function avg(xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x != null);
  if (vals.length === 0) return null;
  return round4(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
