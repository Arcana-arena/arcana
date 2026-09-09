import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_CONFIG, type AuthConfig } from '@arcana/auth';

export interface PriceLookupResult {
  /** False when market-data could not answer. Never conflated with "no prices". */
  available: boolean;
  reason: string | null;
  snapshots: Record<
    string,
    {
      ref: string;
      tick_time: string;
      source: string;
      ingest_mode: string;
      trading_date?: string;
      content_hash: string;
      prices: Record<string, number>;
    }
  >;
  /** Refs market-data holds no readable snapshot for. */
  missing: string[];
}

/**
 * Resolves the prices behind a page of decisions, in ONE upstream call.
 *
 * The price a trade happened at lives only inside the immutable snapshot
 * object, never copied into the decisions table — a second copy of market data
 * is a second thing that can disagree with the evidence. One call per decision
 * row would be an N+1 on a public endpoint, so market-data exposes a batch
 * lookup and this collapses a page into a single request.
 *
 * WHEN IT FAILS it does NOT throw. The decision log is a public read surface,
 * and taking the whole trade history offline because a price enrichment failed
 * would be the wrong trade. It returns `available: false` with a reason, and
 * every row is marked `price_status: "unavailable"` — the caller is told the
 * price is unknown rather than shown a trade that looks priceless. Same rule as
 * the entitlement client's `describe()`: `unknown` is its own answer, and it is
 * never quietly rendered as `none`.
 */
@Injectable()
export class MarketPriceClient {
  private readonly logger = new Logger(MarketPriceClient.name);
  private readonly marketDataUrl: string;

  constructor(
    config: ConfigService,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
  ) {
    this.marketDataUrl =
      config.get<string>('MARKET_DATA_URL') ?? 'http://127.0.0.1:8083';
  }

  async lookup(refs: string[], symbols: string[] = []): Promise<PriceLookupResult> {
    const empty = { snapshots: {}, missing: [] as string[] };

    if (refs.length === 0) {
      return { available: true, reason: null, ...empty };
    }
    if (!this.authCfg.internalKey) {
      const reason = 'INTERNAL_API_KEY is not set, so market-data cannot be called';
      this.logger.warn(`price lookup skipped: ${reason}`);
      return { available: false, reason, ...empty };
    }

    try {
      const res = await fetch(
        `${this.marketDataUrl}/internal/v1/market/snapshots/prices`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': this.authCfg.internalKey,
          },
          body: JSON.stringify({ refs, symbols }),
        },
      );
      if (!res.ok) {
        const reason = `market-data returned HTTP ${res.status}`;
        this.logger.warn(`price lookup failed: ${reason}`);
        return { available: false, reason, ...empty };
      }
      const body = (await res.json()) as {
        snapshots: PriceLookupResult['snapshots'];
        missing: string[];
      };
      return {
        available: true,
        reason: null,
        snapshots: body.snapshots ?? {},
        missing: body.missing ?? [],
      };
    } catch (e) {
      const reason = `market-data unreachable: ${String(e)}`;
      this.logger.warn(`price lookup failed: ${reason}`);
      return { available: false, reason, ...empty };
    }
  }
}
