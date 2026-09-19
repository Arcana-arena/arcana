/**
 * Turning a published claim into a verdict, with nobody's opinion in between.
 *
 * THE RULE WAS WRITTEN BEFORE THE OUTCOME. Everything this service reads —
 * which agent, which benchmark, which margin, which deadline — was fixed when
 * the thesis was published and is refused an edit by the database. All that
 * happens here is arithmetic over data that already existed, and the arithmetic
 * is kept in `measurement` so a reader can redo it instead of believing it.
 *
 * THE AGENT IS NEVER TOUCHED. This file reads portfolio_snapshots,
 * custody_drift and market_snapshots. It writes to public_theses and nothing
 * else. There is no path from here into a mandate, a prompt or a risk profile,
 * which is the property infra/verify/thesis-verify.mjs proves by execution.
 *
 * WHY THE AGENT'S RETURN IS FLOW-ADJUSTED, and the ARCANA Score's is not.
 * The score reads the raw NAV series on purpose and the owner decided it stays
 * that way. But a score is a verdict on an agent, while a thesis is a verdict
 * on a CLAIM ABOUT THE MARKET, and the two break differently on the same event:
 * onchain_live_v1's NAV fell 11.79 -> 3.98 while its own trades netted +0.07,
 * because 7.88 USDG was moved out of the wallet. Judged on raw NAV, a claim
 * that was right would be published as wrong, permanently, because somebody
 * made a transfer. So every recorded external flow is removed and the
 * sub-period returns are chain-linked — the standard time-weighted return.
 * The two numbers WILL disagree, and the thesis page says which is which
 * rather than hiding the difference.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketIndexService, MarketTick } from '../market/market-index.service';
import { BenchmarkRef, ThesisCriteria } from './thesis.entity';

/**
 * The quote token, and the one token whose USD value is not a market price.
 * Same constants as src/stats/stats.service.ts; every other allowlisted token
 * on this chain carries 18 decimals.
 */
const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const USDG_DECIMALS = 6;
const DEFAULT_DECIMALS = 18;

export interface Measurement {
  agent_return: number;
  benchmark_return: number;
  /**
   * Whether each side is a measurement at all.
   *
   * SEPARATE FROM THE VALUE, because the value cannot carry it. An agent with
   * no NAV points and an agent that ended exactly where it started both produce
   * 0.0, and against a benchmark the two compare identically — which is how a
   * thesis written to fail came back PROVEN in verification: nothing-at-all beat
   * a market that had fallen.
   */
  agent_measurable: boolean;
  benchmark_measurable: boolean;
  /**
   * Whether every input the agent's return needed was actually available.
   *
   * SEPARATE FROM `measurable` AGAIN. `measurable: false` means there was
   * nothing to measure; `complete: false` means there was, and a piece of it
   * was missing — an external transfer in a token nobody had a price for, which
   * therefore was not removed. The number still exists and is still the best
   * available, but it is not exact, and a page that printed it like any other
   * figure would be claiming a precision the data does not carry.
   */
  complete: boolean;
  incomplete_because: string | null;
  agent_status: string;
  detail: Record<string, unknown>;
}

interface NavPoint {
  ts: Date;
  nav: number;
}

interface Flow {
  detected_at: Date;
  symbol: string | null;
  token_address: string | null;
  delta_base_units: string;
  usd: number | null;
  priced_from: string | null;
}

@Injectable()
export class ThesisResolutionService {
  private readonly logger = new Logger(ThesisResolutionService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketIndex: MarketIndexService,
  ) {}

  // ------------------------------------------------------------------ agent

  /**
   * Time-weighted return over [from, to], external flows removed.
   *
   *   r_i  = (NAV_i - flow_i) / NAV_(i-1) - 1
   *   TWR  = product(1 + r_i) - 1
   *
   * `flow_i` is every custody_drift row detected in (ts_(i-1), ts_i], valued in
   * USD. Removing it is what stops a deposit reading as skill and a withdrawal
   * reading as a loss.
   */
  private async agentReturn(
    agentId: string,
    from: Date,
    to: Date,
    ticks: Map<string, MarketTick>,
    source: string,
  ): Promise<{
    value: number; measurable: boolean; complete: boolean;
    incomplete_because: string | null; detail: Record<string, unknown>;
  }> {
    // SCOPED THE SAME WAY THE BENCHMARK IS, and this used to be the one place
    // the two sides disagreed. The benchmark is anchored on the first and last
    // tick of ONE market source inside the window; the agent's curve was taken
    // over the raw window across every season and every source. A thesis whose
    // window straddled the simulator/vendor switchover therefore compared a
    // source-scoped benchmark against an unscoped NAV curve — two different
    // bases, printed as one margin. `from` and `to` are now the anchor and
    // final tick themselves, so both sides start and end at the same instant.
    //
    // Season too: portfolio_snapshots carries no season, portfolios does, and
    // an agent that moved seasons mid-window has two capital bases whose
    // returns are not chainable. The season holding the most points in the
    // window is measured and the rest are counted out loud rather than mixed in.
    const seasonRow = await this.db.query(
      `SELECT p.season_id, count(*)::int AS n
         FROM portfolio_snapshots ps
         JOIN portfolios p ON p.id = ps.portfolio_id
        WHERE p.agent_id = $1 AND ps.ts >= $2 AND ps.ts <= $3
        GROUP BY p.season_id
        ORDER BY n DESC, p.season_id ASC`,
      [agentId, from, to],
    );
    const seasonId: string | null = seasonRow[0]?.season_id ?? null;
    const pointsOutsideSeason = seasonRow
      .slice(1)
      .reduce((s: number, r: { n: number }) => s + r.n, 0);

    const navRows: Array<{ ts: Date; nav: string }> = await this.db.query(
      `SELECT ps.ts, ps.nav
         FROM portfolio_snapshots ps
         JOIN portfolios p ON p.id = ps.portfolio_id
        WHERE p.agent_id = $1 AND ps.ts >= $2 AND ps.ts <= $3
          AND ($4::uuid IS NULL OR p.season_id = $4::uuid)
        ORDER BY ps.ts ASC`,
      [agentId, from, to, seasonId],
    );
    const nav: NavPoint[] = navRows.map((r) => ({ ts: r.ts, nav: Number(r.nav) }));

    if (nav.length < 2) {
      // `measurable: false`, NOT a return of 0.
      //
      // Zero is a measurement meaning "it did not move". This is the absence of
      // one, and the two compare identically against a benchmark — which is
      // exactly how thesis-verify caught it: a fixture agent with no portfolio
      // produced 0, the market had fallen, and a thesis written to FAIL
      // resolved PROVEN because nothing-at-all beat a negative number. The flag
      // is what stops the caller ever comparing it.
      return {
        value: 0,
        measurable: false,
        complete: false,
        incomplete_because: 'there were not two NAV snapshots to measure between',
        detail: {
          nav_points: nav.length,
          season_id: seasonId,
          insufficient_data:
            'fewer than two NAV snapshots inside the window, so no return could be measured',
        },
      };
    }

    const flows = await this.flows(agentId, from, to, ticks, source);

    // A FLOW NOBODY COULD PRICE IS A HOLE, NOT A ZERO.
    //
    // `usd: null` means the token had no price at that tick. Summed with `?? 0`
    // it contributes nothing, which is arithmetically identical to no transfer
    // having happened — and the error always runs one way: an unremoved
    // withdrawal flatters nobody, but an unremoved DEPOSIT reads as skill. The
    // adjustment silently not happening is exactly the failure this file exists
    // to avoid, so the count travels with the result and the page refuses to
    // print a clean figure from it.
    const unpriced = flows.filter((f) => f.usd === null);
    const complete = unpriced.length === 0;
    const incompleteBecause = complete
      ? null
      : `${unpriced.length} external transfer${unpriced.length === 1 ? '' : 's'} ` +
        `(${[...new Set(unpriced.map((f) => f.symbol ?? 'unknown token'))].join(', ')}) ` +
        'could not be priced at the tick they were detected on, so they were not removed from ' +
        'this return. The figure is therefore a floor on the error, not an exact measurement.';

    let factor = 1;
    const legs: Array<Record<string, unknown>> = [];
    for (let i = 1; i < nav.length; i++) {
      const prev = nav[i - 1];
      const cur = nav[i];
      const flow = flows
        .filter((f) => f.detected_at > prev.ts && f.detected_at <= cur.ts)
        .reduce((sum, f) => sum + (f.usd ?? 0), 0);

      if (prev.nav <= 0) {
        // A portfolio worth nothing has no return to speak of; dividing by it
        // would manufacture one. The sub-period is skipped and said so.
        legs.push({ from: prev.ts, to: cur.ts, skipped: 'previous NAV was not positive' });
        continue;
      }
      const r = (cur.nav - flow) / prev.nav - 1;
      factor *= 1 + r;
      legs.push({
        from: prev.ts,
        to: cur.ts,
        nav_from: prev.nav,
        nav_to: cur.nav,
        external_flow_usd: flow,
        sub_return: r,
      });
    }

    return {
      value: factor - 1,
      measurable: true,
      complete,
      incomplete_because: incompleteBecause,
      detail: {
        method: 'time-weighted return, external flows removed',
        season_id: seasonId,
        nav_points_outside_measured_season: pointsOutsideSeason,
        external_flows_unpriced: unpriced.length,
        nav_points: nav.length,
        nav_first: { ts: nav[0].ts, nav: nav[0].nav },
        nav_last: { ts: nav[nav.length - 1].ts, nav: nav[nav.length - 1].nav },
        raw_nav_return: nav[0].nav > 0 ? nav[nav.length - 1].nav / nav[0].nav - 1 : null,
        external_flows: flows,
        sub_periods: legs,
      },
    };
  }

  /** Every recorded external flow in the window, valued in USD. */
  private async flows(
    agentId: string,
    from: Date,
    to: Date,
    ticks: Map<string, MarketTick>,
    source: string,
  ): Promise<Flow[]> {
    const rows: Array<{
      detected_at: Date;
      symbol: string | null;
      token_address: string | null;
      delta: string;
    }> = await this.db.query(
      `SELECT detected_at, symbol, token_address, delta
         FROM custody_drift
        WHERE agent_id = $1 AND detected_at > $2 AND detected_at <= $3
        ORDER BY detected_at ASC`,
      [agentId, from, to],
    );

    // Ticks of the chosen source, oldest first, for "the price as at".
    const ordered = [...ticks.values()]
      .filter((t) => t.source === source)
      .sort((a, b) => a.tickTime.getTime() - b.tickTime.getTime());

    return rows.map((r) => {
      const decimals =
        r.token_address && r.token_address.toLowerCase() === USDG_ADDRESS.toLowerCase()
          ? USDG_DECIMALS
          : r.symbol === 'USDG'
            ? USDG_DECIMALS
            : DEFAULT_DECIMALS;
      const units = Number(r.delta) / Math.pow(10, decimals);

      // The quote token IS the unit of account: one USDG is one dollar here by
      // definition, not by a price lookup that could fail.
      if (r.symbol === 'USDG' ||
          (r.token_address && r.token_address.toLowerCase() === USDG_ADDRESS.toLowerCase())) {
        return { detected_at: r.detected_at, symbol: r.symbol, token_address: r.token_address,
                 delta_base_units: r.delta, usd: units, priced_from: 'quote token, 1:1' };
      }

      const at = [...ordered].reverse().find((t) => t.tickTime <= r.detected_at);
      const price = at?.prices?.[r.symbol ?? ''] ?? null;
      if (price === null || price === undefined) {
        // UNPRICED, NOT GUESSED AT ZERO. A flow valued at zero would silently
        // be treated as no flow at all, which is the direction that flatters
        // the agent. It is carried through to `measurement` unvalued so the
        // page can say the adjustment is incomplete.
        return { detected_at: r.detected_at, symbol: r.symbol, token_address: r.token_address,
                 delta_base_units: r.delta, usd: null, priced_from: null };
      }
      return { detected_at: r.detected_at, symbol: r.symbol, token_address: r.token_address,
               delta_base_units: r.delta, usd: units * price, priced_from: at!.ref };
    });
  }

  // -------------------------------------------------------------- benchmark

  /**
   * What the thing being compared against did over the same window.
   *
   * SCOPED TO ONE SOURCE, for the reason market-index.service.ts gives at
   * length: simulator and vendor snapshots interleave by tick_time, and the
   * "return" between a generated price and a real one is the gap between two
   * unrelated worlds rather than a market move.
   */
  private benchmarkReturn(
    ref: BenchmarkRef,
    from: Date,
    to: Date,
    ticks: Map<string, MarketTick>,
    source: string,
  ): { value: number; measurable: boolean; detail: Record<string, unknown> } {
    const window = [...ticks.values()]
      .filter((t) => t.source === source && t.tickTime >= from && t.tickTime <= to)
      .sort((a, b) => a.tickTime.getTime() - b.tickTime.getTime());

    if (window.length < 2) {
      return {
        value: 0,
        measurable: false,
        detail: { ticks: window.length, source,
                  insufficient_data: 'fewer than two market ticks inside the window' },
      };
    }

    if (ref.kind === 'arcana_index') {
      // Chain-link the stored per-tick index, anchored on the first tick in the
      // window: that tick's own return covers a period that began before the
      // thesis did, so it is the anchor rather than a term.
      let factor = 1;
      for (let i = 1; i < window.length; i++) factor *= 1 + window[i].marketReturn;
      return {
        value: factor - 1,
        measurable: true,
        detail: {
          kind: 'arcana_index', source, ticks: window.length,
          anchor: window[0].ref, final: window[window.length - 1].ref,
          definition: 'equal-weighted mean of per-symbol returns per tick, market_snapshots.market_return',
        },
      };
    }

    const first = window[0];
    const last = window[window.length - 1];
    const legs = (ref.symbols ?? []).map((sym) => {
      const p0 = first.prices?.[sym] ?? null;
      const p1 = last.prices?.[sym] ?? null;
      const value = p0 !== null && p1 !== null && p0 > 0 ? p1 / p0 - 1 : null;
      return { symbol: sym, price_from: p0, price_to: p1, return: value };
    });

    const priced = legs.filter((l) => l.return !== null) as Array<{ symbol: string; return: number }>;
    if (priced.length === 0) {
      return {
        value: 0,
        measurable: false,
        detail: { kind: ref.kind, source, legs,
                  insufficient_data: 'no benchmark symbol could be priced at both ends of the window' },
      };
    }

    // Equal weight, never rebalanced: the basket is bought at the anchor tick
    // and held. Any other weighting is a portfolio decision, and a benchmark
    // that makes decisions is not a benchmark.
    const value = priced.reduce((s, l) => s + l.return, 0) / priced.length;
    return {
      value,
      measurable: true,
      detail: {
        kind: ref.kind, source, anchor: first.ref, final: last.ref,
        weighting: 'equal, held from anchor to final',
        legs,
        legs_unpriced: legs.length - priced.length,
      },
    };
  }

  // ------------------------------------------------------------------ apply

  /** Measure one thesis. Reads only; the caller decides and writes. */
  async measure(thesis: {
    id: string;
    linked_agent_id: string;
    benchmark_ref: BenchmarkRef;
    created_at: Date;
    resolves_at: Date;
  }): Promise<Measurement> {
    const agentRow = await this.db.query(
      `SELECT status FROM agents WHERE id = $1`, [thesis.linked_agent_id]);
    const agentStatus: string = agentRow[0]?.status ?? 'unknown';

    // Prices are the expensive part, so only the refs inside the window are
    // asked for. The index itself is cheap — it is stored.
    const bare = await this.marketIndex.load();
    const source = this.dominantSource(bare, thesis.created_at, thesis.resolves_at);
    const inWindow = [...bare.values()].filter(
      (t) => t.source === source && t.tickTime >= thesis.created_at && t.tickTime <= thesis.resolves_at);

    // Asked for even when the benchmark is the stored index and needs none: a
    // flow paid in a stock token still has to be valued before it can be
    // removed from the agent's return, and an unpriced flow is an adjustment
    // that silently does not happen.
    const ticks = await this.marketIndex.load({
      withPricesFor: inWindow.map((t) => t.ref),
    });

    // THE ANCHOR AND FINAL TICK ARE THE WINDOW FOR BOTH SIDES.
    //
    // The benchmark was always measured from the first tick of the chosen
    // source to its last; the agent was measured over the creator's raw
    // created_at..resolves_at. Those are different intervals whenever the
    // market has no tick at either edge — which is every thesis, since a
    // creator picks a deadline and the market ticks on its own cadence. Both
    // now run between the same two instants, so the margin subtracts two
    // returns measured over one period rather than two overlapping ones.
    const ordered = inWindow.sort((a, b) => a.tickTime.getTime() - b.tickTime.getTime());
    const anchor = ordered[0]?.tickTime ?? thesis.created_at;
    const final = ordered[ordered.length - 1]?.tickTime ?? thesis.resolves_at;

    const agent = await this.agentReturn(
      thesis.linked_agent_id, anchor, final, ticks, source);
    const benchmark = this.benchmarkReturn(
      thesis.benchmark_ref, anchor, final, ticks, source);

    return {
      agent_return: agent.value,
      benchmark_return: benchmark.value,
      agent_measurable: agent.measurable,
      benchmark_measurable: benchmark.measurable,
      complete: agent.complete,
      incomplete_because: agent.incomplete_because,
      agent_status: agentStatus,
      detail: {
        published_window: { from: thesis.created_at, to: thesis.resolves_at },
        // The interval BOTH returns were actually measured over, which is not
        // the published one: it is trimmed to the ticks that exist inside it.
        measured_window: { from: anchor, to: final },
        market_source: source,
        agent: agent.detail,
        benchmark: benchmark.detail,
      },
    };
  }

  /** The source that actually covers the window, so the two sides agree. */
  private dominantSource(ticks: Map<string, MarketTick>, from: Date, to: Date): string {
    const counts = new Map<string, number>();
    for (const t of ticks.values()) {
      if (t.tickTime < from || t.tickTime > to) continue;
      counts.set(t.source, (counts.get(t.source) ?? 0) + 1);
    }
    let best = 'unknown';
    let seen = -1;
    for (const [src, n] of counts) if (n > seen) { best = src; seen = n; }
    return best;
  }

  /** proven when the agent beat the benchmark by at least the locked margin. */
  static verdict(agentReturn: number, benchmarkReturn: number, criteria: ThesisCriteria):
    'proven' | 'not_proven' {
    const margin = (criteria.margin_pct ?? 0) / 100;
    return agentReturn > benchmarkReturn + margin ? 'proven' : 'not_proven';
  }

  /**
   * Resolve every thesis whose deadline has passed. Idempotent: the row is
   * updated only while it is still pending, and the database refuses a second
   * resolution anyway.
   *
   * ONE FAILURE DOES NOT STOP THE REST. A thesis whose measurement throws is
   * logged and left pending for the next run, because the alternative is one
   * unreadable snapshot freezing every other creator's record.
   */
  async resolveDue(now: Date = new Date()): Promise<{
    considered: number; resolved: number; failed: number; skipped: number;
    results: Array<{ id: string; status: string }>;
  }> {
    const due: Array<{
      id: string; linked_agent_id: string; benchmark_ref: BenchmarkRef;
      criteria: ThesisCriteria; created_at: Date; resolves_at: Date;
    }> = await this.db.query(
      `SELECT id, linked_agent_id, benchmark_ref, criteria, created_at, resolves_at
         FROM public_theses
        WHERE status = 'pending' AND resolves_at <= $1
        ORDER BY resolves_at ASC`,
      [now],
    );

    const results: Array<{ id: string; status: string }> = [];
    let failed = 0;
    let skipped = 0;

    for (const t of due) {
      try {
        const m = await this.measure(t);

        // AN UNMEASURABLE BENCHMARK IS OUR GAP, NOT THE CREATOR'S. The market
        // data for the window could not be read, which says nothing about the
        // claim. The row stays pending and the next hourly run tries again —
        // resolution happens once and for good, so a verdict reached on data
        // we could not read is one nobody can take back.
        if (!m.benchmark_measurable) {
          skipped++;
          this.logger.warn(
            `thesis ${t.id} stays pending: the benchmark could not be measured over its window ` +
            `(${JSON.stringify((m.detail as Record<string, unknown>).benchmark)})`);
          continue;
        }

        // AN UNMEASURABLE AGENT IS NOT. A claim whose agent produced no
        // readable NAV over the whole window was never demonstrated, and
        // not_proven is what "not demonstrated" means here. Voiding it would
        // be an escape hatch of exactly the kind a pause must not be either.
        const status = m.agent_measurable
          ? ThesisResolutionService.verdict(m.agent_return, m.benchmark_return, t.criteria)
          : 'not_proven';
        const updated = await this.db.query(
          `UPDATE public_theses
              SET status = $2, result_performance = $3, result_benchmark = $4,
                  resolved_at = now(), agent_status_at_resolution = $5, measurement = $6
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          // Completeness rides inside `measurement` rather than in a column of
          // its own: the blob already exists to hold everything the verdict was
          // made from, and a fact about the arithmetic belongs beside the
          // arithmetic. No migration, and nothing can read the number without
          // the caveat sitting next to it.
          [t.id, status, m.agent_return, m.benchmark_return, m.agent_status,
           JSON.stringify({
             ...m.detail,
             complete: m.complete,
             incomplete_because: m.incomplete_because,
           })],
        );
        if (updated.length > 0) results.push({ id: t.id, status });
      } catch (e) {
        failed++;
        this.logger.error(
          `thesis ${t.id} could not be resolved and stays pending: ${
            e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { considered: due.length, resolved: results.length, failed, skipped, results };
  }
}
