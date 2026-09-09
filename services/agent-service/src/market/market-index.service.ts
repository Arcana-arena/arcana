import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The market as an equal-weighted index, per tick.
 *
 * Extracted so Agent DNA and Agent Evolution read the same market rather than
 * each deriving its own: two definitions of "what the market did" would sooner
 * or later disagree, and both features use it to judge an agent against its
 * conditions.
 *
 * Prices live in object storage, not the database, so a load walks the
 * market-data service once and the caller reuses the result.
 */

export interface MarketTick {
  ref: string;
  tickTime: Date;
  prices: Record<string, number>;
  /**
   * Equal-weighted mean of per-symbol returns since the previous tick
   * FROM THE SAME SOURCE.
   *
   * Scoping by source is load-bearing. Simulator snapshots are dated around the
   * switchover while backfilled vendor snapshots span the preceding months, so
   * a single tick_time ordering interleaves them — and the "return" between a
   * generated price and a real one is not a return at all, it is the gap
   * between two unrelated worlds. It would then flow into every DNA feature and
   * evolution comparison that asks what the market did.
   */
  marketReturn: number;
  /** `polygon`, `simulator`, ... — which market produced this tick. */
  source: string;
}

@Injectable()
export class MarketIndexService {
  private readonly logger = new Logger(MarketIndexService.name);
  private readonly marketDataUrl: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.marketDataUrl =
      config.get<string>('MARKET_DATA_URL') ?? 'http://localhost:8083';
  }

  /**
   * Cached because a load is one HTTP round trip per snapshot — fine for a
   * daily batch, far too slow for a read-model answering a web request. The TTL
   * is short: the scheduler adds at most one tick per minute, so a minute-old
   * index is at worst missing the newest tick, and nothing here is used for
   * settlement.
   */
  private cache: { at: number; data: Map<string, MarketTick> } | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  /** Every recorded tick, oldest first, keyed by snapshot ref. */
  async load(): Promise<Map<string, MarketTick>> {
    if (this.cache && Date.now() - this.cache.at < MarketIndexService.CACHE_TTL_MS) {
      return this.cache.data;
    }
    // Ordered by source first, so each source's series is walked contiguously
    // and `prev` never crosses from one market into another.
    const refs: Array<{ ref: string; tick_time: Date; source: string }> =
      await this.db.query(
        `SELECT ref, tick_time, source FROM market_snapshots
         ORDER BY source ASC, tick_time ASC`,
      );

    const out = new Map<string, MarketTick>();
    let prev: Record<string, number> | null = null;
    let prevSource: string | null = null;

    for (const row of refs) {
      if (row.source !== prevSource) {
        // First tick of a new source: it has no predecessor in its own world.
        prev = null;
        prevSource = row.source;
      }
      let prices: Record<string, number>;
      try {
        const res = await fetch(
          `${this.marketDataUrl}/v1/market/snapshots/${row.ref}`,
        );
        if (!res.ok) continue;
        const snap = (await res.json()) as {
          symbols: Array<{ symbol: string; price: number }>;
        };
        prices = Object.fromEntries(snap.symbols.map((s) => [s.symbol, s.price]));
      } catch (e) {
        this.logger.warn(`market snapshot ${row.ref} unavailable: ${e}`);
        continue;
      }

      let marketReturn = 0;
      if (prev) {
        const rets: number[] = [];
        for (const [sym, price] of Object.entries(prices)) {
          const before = prev[sym];
          if (before > 0) rets.push(price / before - 1);
        }
        marketReturn =
          rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
      }

      out.set(row.ref, {
        ref: row.ref,
        tickTime: row.tick_time,
        prices,
        marketReturn,
        source: row.source,
      });
      prev = prices;
    }
    this.cache = { at: Date.now(), data: out };
    return out;
  }

  /**
   * Compounded market return over a time window, as a percentage.
   *
   * This is what makes an evolution comparison honest: two versions of an agent
   * run in different periods, so "v2 scored higher" may only mean v2 met a
   * kinder market. Knowing what the market itself did over each window is the
   * cheapest way to tell the two apart.
   */
  compoundedReturnPct(
    market: Map<string, MarketTick>,
    from: Date | null,
    to: Date | null,
  ): number | null {
    if (!from || !to) return null;
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();

    let factor = 1;
    let counted = 0;
    for (const tick of market.values()) {
      const t = new Date(tick.tickTime).getTime();
      // Strictly after the start: the first tick's return belongs to the
      // window before this one.
      if (t > start && t <= end) {
        factor *= 1 + tick.marketReturn;
        counted++;
      }
    }
    return counted > 0 ? round4((factor - 1) * 100) : null;
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
