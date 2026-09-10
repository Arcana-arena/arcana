import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The market as an equal-weighted index, per tick.
 *
 * Extracted so Agent DNA, Agent Autopsy and Agent Evolution read the same
 * market rather than each deriving its own: two definitions of "what the market
 * did" would sooner or later disagree, and all three use it to judge an agent
 * against its conditions. **That is still true after this rewrite** — the index
 * is computed here and nowhere else. The database now stores the result, but
 * storing a number is not defining it.
 */

export interface MarketTick {
  ref: string;
  tickTime: Date;
  /**
   * Prices for this tick, or `null` when they were not requested.
   *
   * Nullable on purpose. Prices are the expensive part — one object read each —
   * so they are fetched only for the refs a caller actually needs. If this were
   * an empty object instead of null, a caller that forgot to ask would read
   * zeros and silently produce wrong numbers, which is the failure mode this
   * codebase keeps writing down as worse than a crash. `null` makes the
   * compiler ask the question at every call site.
   */
  prices: Record<string, number> | null;
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

export interface LoadOptions {
  /**
   * Refs whose `prices` the caller needs. Anything else comes back with
   * `prices: null`.
   *
   * Omit it and no prices are loaded at all, which is the right answer for a
   * caller that only wants returns — Evolution, for one, never touches a price.
   */
  withPricesFor?: Iterable<string>;
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
   * Prices, keyed by ref, for the life of the process.
   *
   * **No TTL, and that is not an oversight.** A snapshot is immutable by
   * construction — content-hashed, never rewritten — so its prices cannot go
   * stale. What changes is the SET of snapshots, and that is handled by the
   * index being re-read from SQL on every load. The previous 60-second TTL
   * threw away everything once a minute and paid for the whole index again,
   * including the 259 snapshots that could not possibly have changed.
   *
   * Bounded so a long-lived process cannot grow without limit; eviction is
   * oldest-first and costs at most a re-fetch.
   */
  private readonly priceCache = new Map<string, Record<string, number>>();
  private static readonly PRICE_CACHE_MAX = 4000;

  /** How many refs to fetch at once. Server-side throughput is the limit, not
   * latency — measured: concurrency 8 and 64 perform the same — so this is kept
   * modest to leave the market-data service responsive to everything else. */
  private static readonly FETCH_CONCURRENCY = 8;

  /**
   * Every recorded tick, oldest first, keyed by snapshot ref.
   *
   * Returns come from `market_snapshots.market_return`, computed here once and
   * stored (migration 0025). Only rows still NULL cost anything, and each costs
   * that once ever.
   */
  async load(opts: LoadOptions = {}): Promise<Map<string, MarketTick>> {
    // Ordered by source first, so each source's series is walked contiguously
    // and `prev` never crosses from one market into another.
    const rows: Array<{
      ref: string;
      tick_time: Date;
      source: string;
      market_return: number | null;
    }> = await this.db.query(
      `SELECT ref, tick_time, source, market_return FROM market_snapshots
       ORDER BY source ASC, tick_time ASC`,
    );

    const pending = rows.filter((r) => r.market_return === null);
    if (pending.length > 0) {
      await this.computeAndStoreReturns(rows);
    }

    const wanted = opts.withPricesFor ? new Set(opts.withPricesFor) : null;
    if (wanted && wanted.size > 0) {
      await this.warmPrices([...wanted].filter((ref) => !this.priceCache.has(ref)));
    }

    const out = new Map<string, MarketTick>();
    for (const row of rows) {
      // A row whose return is still null after the pass above could not be
      // computed — its snapshot payload was unreachable. Leaving it out keeps
      // the old behaviour: an unreadable tick never entered the index.
      if (row.market_return === null) continue;
      out.set(row.ref, {
        ref: row.ref,
        tickTime: row.tick_time,
        prices: wanted?.has(row.ref) ? (this.priceCache.get(row.ref) ?? null) : null,
        marketReturn: row.market_return,
        source: row.source,
      });
    }
    return out;
  }

  /**
   * Load prices for `refs` into an already-loaded index, in place.
   *
   * For callers that cannot know which refs they need until they have seen the
   * index — Autopsy works out a ±5-tick window around each trade, which depends
   * on the ordering. The alternative was loading twice, which would run the
   * query twice to answer the same question.
   *
   * Refs already carrying prices are left alone; refs absent from the index are
   * ignored rather than invented.
   */
  async ensurePrices(
    market: Map<string, MarketTick>,
    refs: Iterable<string>,
  ): Promise<void> {
    const wanted = [...new Set(refs)].filter((r) => market.has(r));
    await this.warmPrices(wanted.filter((r) => !this.priceCache.has(r)));
    for (const ref of wanted) {
      const tick = market.get(ref);
      const prices = this.priceCache.get(ref);
      if (tick && prices) tick.prices = prices;
    }
  }

  /**
   * Fill in `market_return` for rows that do not have one yet.
   *
   * Walks the full ordered list — not just the pending rows — because a return
   * is measured against the PREVIOUS tick in the same source, and that
   * predecessor may already be computed. Prices are fetched only where they are
   * actually needed: for a pending row and for the row before it.
   *
   * The arithmetic is deliberately unchanged from the version this replaces,
   * including its edge cases. A tick whose prices cannot be fetched is skipped
   * and does NOT become the predecessor of the next one, so a gap does not
   * corrupt the tick after it.
   */
  private async computeAndStoreReturns(
    rows: Array<{ ref: string; tick_time: Date; source: string; market_return: number | null }>,
  ): Promise<void> {
    const needed = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].market_return !== null) continue;
      needed.add(rows[i].ref);
      // Its predecessor within the same source, whichever that turns out to be.
      for (let j = i - 1; j >= 0 && rows[j].source === rows[i].source; j--) {
        needed.add(rows[j].ref);
        break;
      }
    }
    await this.warmPrices([...needed].filter((ref) => !this.priceCache.has(ref)));

    const updates: Array<{ ref: string; value: number }> = [];
    let prev: Record<string, number> | null = null;
    let prevSource: string | null = null;

    for (const row of rows) {
      if (row.source !== prevSource) {
        // First tick of a new source: it has no predecessor in its own world.
        prev = null;
        prevSource = row.source;
      }
      const prices = this.priceCache.get(row.ref) ?? null;

      if (row.market_return !== null) {
        // Already stored. It still has to take its turn as `prev` for whatever
        // comes next, but only if we know its prices; when we do not, the next
        // pending row measures against the last tick we could actually read —
        // exactly as the original loop did.
        if (prices) prev = prices;
        continue;
      }
      if (!prices) continue; // unreadable; leaves `prev` alone

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
      updates.push({ ref: row.ref, value: marketReturn });
      row.market_return = marketReturn;
      prev = prices;
    }

    if (updates.length === 0) return;
    // One statement, not one per row: at first backfill this is every snapshot
    // that has ever existed.
    await this.db.query(
      `UPDATE market_snapshots AS m SET market_return = v.val
       FROM (SELECT unnest($1::text[]) AS ref, unnest($2::float8[]) AS val) AS v
       WHERE m.ref = v.ref`,
      [updates.map((u) => u.ref), updates.map((u) => u.value)],
    );
    this.logger.log(`market index: computed and stored ${updates.length} tick return(s)`);
  }

  /** Fetch prices for refs not already cached, a few at a time. */
  private async warmPrices(refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(MarketIndexService.FETCH_CONCURRENCY, refs.length) },
      async () => {
        for (;;) {
          const i = next++;
          if (i >= refs.length) return;
          const ref = refs[i];
          try {
            const res = await fetch(`${this.marketDataUrl}/v1/market/snapshots/${ref}`);
            if (!res.ok) continue;
            const snap = (await res.json()) as {
              symbols: Array<{ symbol: string; price: number }>;
            };
            this.remember(ref, Object.fromEntries(snap.symbols.map((s) => [s.symbol, s.price])));
          } catch (e) {
            this.logger.warn(`market snapshot ${ref} unavailable: ${e}`);
          }
        }
      },
    );
    await Promise.all(workers);
  }

  private remember(ref: string, prices: Record<string, number>): void {
    if (this.priceCache.size >= MarketIndexService.PRICE_CACHE_MAX) {
      const oldest = this.priceCache.keys().next().value;
      if (oldest !== undefined) this.priceCache.delete(oldest);
    }
    this.priceCache.set(ref, prices);
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
