import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketPriceClient } from './market-price.client';
import {
  DECISIONS_PAGE_SIZE_DEFAULT,
  DECISIONS_PAGE_SIZE_MAX,
  MAX_BUCKETS,
  SERIES_PAGE_SIZE_DEFAULT,
  SERIES_PAGE_SIZE_MAX,
  type DecisionsQueryDto,
  type SeriesQueryDto,
} from './dto/series-query.dto';

/**
 * Below this an agent has not competed. Same constant as the Passport, Agent
 * DNA and the scoring engine's participation rule — repeated here as a value,
 * not re-decided: a series must describe an unranked agent the same way every
 * other surface does.
 */
const MIN_DECISIONS = 5;

function numeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** '15m' | '1h' | '1d' | '2w' -> a Postgres interval literal. */
function toInterval(resolution: string): string {
  const n = resolution.slice(0, -1);
  const unit = resolution.slice(-1);
  const units: Record<string, string> = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' };
  return `${n} ${units[unit]}`;
}

/** Bucket widths `auto` may choose from, coarsest last. */
const AUTO_LADDER = ['1m', '5m', '15m', '1h', '6h', '1d', '1w'];

export interface SeriesPoint {
  ts: string;
  season_id: string;
  /** Which role this point played in its bucket. 'raw' when not bucketed. */
  agg: 'raw' | 'first' | 'min' | 'max' | 'last';
  [k: string]: unknown;
}

@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly prices: MarketPriceClient,
  ) {}

  // --- shared ---------------------------------------------------------------

  private async loadAgent(agentId: string) {
    const rows = await this.db.query(
      `SELECT id, name, version, status, creator_id FROM agents WHERE id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    return rows[0];
  }

  /**
   * Whether the agent has competed, and the count behind that verdict.
   *
   * An agent below the threshold is NOT given an empty array and left to look
   * like a flat line at zero. It gets `ranked: false` and a stated reason, the
   * same way the Passport withholds rank and badges — absence of data, said out
   * loud, rather than data that reads as absence of performance.
   */
  private async participation(agentId: string) {
    const rows = await this.db.query(
      `SELECT count(*)::int AS decisions FROM decisions WHERE agent_id = $1`,
      [agentId],
    );
    const decisions = rows[0]?.decisions ?? 0;
    return {
      decisions,
      threshold_decisions: MIN_DECISIONS,
      ranked: decisions >= MIN_DECISIONS,
    };
  }

  /**
   * The seasons a series touches, with the market each was run against.
   *
   * This is what lets a chart break its line. Season 1 was scored against
   * simulator prices and Season 2 against a real vendor; one continuous curve
   * through both would draw a career that never happened. The provenance is
   * read from the snapshots the decisions actually cite, not assumed from the
   * season's dates.
   */
  private async seasonIndex(agentId: string, seasonIds: string[]) {
    if (seasonIds.length === 0) return [];
    const rows = await this.db.query(
      `SELECT s.id           AS season_id,
              s.name         AS season_name,
              s.start_at, s.end_at,
              COALESCE(
                (SELECT array_agg(DISTINCT ms.source || ':' || ms.ingest_mode)
                   FROM decisions d
                   JOIN market_snapshots ms ON ms.ref = d.market_snapshot_ref
                  WHERE d.agent_id = $1 AND d.season_id = s.id),
                ARRAY[]::text[]
              ) AS market_sources
         FROM seasons s
        WHERE s.id = ANY($2::uuid[])
        ORDER BY s.start_at ASC`,
      [agentId, seasonIds],
    );
    return rows.map((r: any) => ({
      season_id: r.season_id,
      season_name: r.season_name,
      start_at: r.start_at,
      end_at: r.end_at,
      /** e.g. ["simulator:live"] — the caveat applies to THIS span, not the chart. */
      market_sources: r.market_sources ?? [],
    }));
  }

  private windowClause(q: SeriesQueryDto | DecisionsQueryDto, params: unknown[], tsCol: string) {
    let sql = '';
    if (q.season_id) {
      params.push(q.season_id);
      sql += ` AND season_id = $${params.length}`;
    }
    if (q.from) {
      params.push(q.from);
      sql += ` AND ${tsCol} >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      sql += ` AND ${tsCol} <= $${params.length}`;
    }
    return sql;
  }

  private paging(q: { page?: number; page_size?: number }, def: number, max: number) {
    const page = q.page && q.page > 0 ? q.page : 1;
    // Over-large page sizes are clamped rather than rejected: a caller asking
    // for too much gets the maximum and is told so in the response.
    const requested = q.page_size ?? def;
    const pageSize = Math.min(Math.max(requested, 1), max);
    return { page, pageSize, clamped: requested > max };
  }

  /**
   * Expand one bucket into the points that must survive downsampling.
   *
   * FIRST, MIN, MAX, LAST — at their real timestamps, in time order, deduped.
   *
   * This is min/max decimation, and it is chosen over LTTB deliberately. LTTB
   * optimises how *similar* the reduced line looks; it offers no guarantee that
   * any particular point survives, so the deepest drawdown can vanish at low
   * resolution. Here the global minimum of a series is, by definition, the
   * minimum of its own bucket, and every bucket emits its minimum — so the
   * extreme is present at every resolution. Same for the peak.
   *
   * The cost, stated plainly: up to 4 points per bucket rather than 1, and a
   * line that zigzags within a bucket instead of smoothing. That is the correct
   * trade for a track record, where the worst moment is the point of the chart.
   */
  private expandBucket(
    seasonId: string,
    fields: string[],
    row: Record<string, any>,
    primary: string,
  ): SeriesPoint[] {
    const candidates: Array<{ ts: string; agg: SeriesPoint['agg'] }> = [
      { ts: row.first_ts, agg: 'first' },
      { ts: row.min_ts, agg: 'min' },
      { ts: row.max_ts, agg: 'max' },
      { ts: row.last_ts, agg: 'last' },
    ];

    const byTs = new Map<string, SeriesPoint>();
    for (const c of candidates) {
      if (!c.ts) continue;
      const key = new Date(c.ts).toISOString();
      const existing = byTs.get(key);
      if (existing) {
        // One timestamp can be several things at once (a single-point bucket is
        // first, min, max and last). Keep the most informative label.
        if (existing.agg !== 'min' && existing.agg !== 'max') existing.agg = c.agg;
        continue;
      }
      const point: SeriesPoint = { ts: key, season_id: seasonId, agg: c.agg };
      for (const f of fields) {
        point[f] = numeric(row[`${c.agg}_${f}`] ?? row[`${c.agg}_v`]);
      }
      // Only the primary field is min/max-tracked; companions are carried from
      // the same row so a point is never a blend of different instants.
      point[primary] = numeric(row[`${c.agg}_v`]);
      byTs.set(key, point);
    }

    return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  private async chooseResolution(
    requested: string | undefined,
    totalPoints: number,
    pageSize: number,
    countBuckets: (interval: string) => Promise<number>,
  ): Promise<{ mode: 'raw' | 'bucketed'; bucket: string | null; reason: string }> {
    const res = requested ?? 'auto';

    if (res === 'raw') {
      return { mode: 'raw', bucket: null, reason: 'resolution=raw requested' };
    }

    if (res !== 'auto') {
      const interval = toInterval(res);
      const n = await countBuckets(interval);
      if (n > MAX_BUCKETS) {
        throw new BadRequestException({
          error: {
            code: 'resolution_too_fine',
            message:
              `resolution=${res} over this range would produce ${n} buckets (max ${MAX_BUCKETS}). ` +
              'Use a coarser resolution or narrow from/to.',
            trace_id: '',
          },
        });
      }
      return { mode: 'bucketed', bucket: res, reason: `resolution=${res} requested` };
    }

    // auto: raw while it fits, then the finest ladder rung that does.
    if (totalPoints <= pageSize) {
      return {
        mode: 'raw',
        bucket: null,
        reason: `auto: ${totalPoints} points fit within page_size=${pageSize}`,
      };
    }
    // Each bucket emits up to 4 points, so aim for a quarter of the budget.
    const targetBuckets = Math.max(Math.floor(pageSize / 4), 1);
    for (const rung of AUTO_LADDER) {
      const n = await countBuckets(toInterval(rung));
      if (n <= targetBuckets) {
        return {
          mode: 'bucketed',
          bucket: rung,
          reason: `auto: ${totalPoints} points exceed page_size=${pageSize}; ${rung} buckets to ${n} groups`,
        };
      }
    }
    const coarsest = AUTO_LADDER[AUTO_LADDER.length - 1];
    return {
      mode: 'bucketed',
      bucket: coarsest,
      reason: `auto: ${totalPoints} points; using the coarsest rung ${coarsest}`,
    };
  }

  // --- score series ---------------------------------------------------------

  async scoreSeries(agentId: string, q: SeriesQueryDto) {
    const agent = await this.loadAgent(agentId);
    const part = await this.participation(agentId);
    const { page, pageSize, clamped } = this.paging(q, SERIES_PAGE_SIZE_DEFAULT, SERIES_PAGE_SIZE_MAX);

    const fields = [
      'arcana_score', 'performance_score', 'risk_score',
      'consistency_score', 'strategy_score', 'longevity_score',
    ];

    const baseParams: unknown[] = [agentId];
    const where = `agent_id = $1${this.windowClause(q, baseParams, 'ts')}`;

    const totalRow = await this.db.query(
      `SELECT count(*)::int AS n, min(ts) AS first_ts, max(ts) AS last_ts
         FROM score_snapshots WHERE ${where}`,
      baseParams,
    );
    const totalPoints: number = totalRow[0]?.n ?? 0;

    const countBuckets = async (interval: string) => {
      const r = await this.db.query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM score_snapshots WHERE ${where}
            GROUP BY season_id, time_bucket($${baseParams.length + 1}::interval, ts)
         ) t`,
        [...baseParams, interval],
      );
      return r[0]?.n ?? 0;
    };

    const resolution = await this.chooseResolution(q.resolution, totalPoints, pageSize, countBuckets);

    let points: SeriesPoint[];
    let total: number;

    if (resolution.mode === 'raw') {
      total = totalPoints;
      const rows = await this.db.query(
        `SELECT ts, season_id, ${fields.join(', ')}
           FROM score_snapshots WHERE ${where}
          ORDER BY ts ASC
          LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
        [...baseParams, pageSize, (page - 1) * pageSize],
      );
      points = rows.map((r: any) => {
        const p: SeriesPoint = { ts: new Date(r.ts).toISOString(), season_id: r.season_id, agg: 'raw' };
        for (const f of fields) p[f] = numeric(r[f]);
        return p;
      });
    } else {
      // GROUP BY season_id first: a bucket can never straddle two seasons, so a
      // downsampled point is always attributable to one market.
      const rows = await this.db.query(
        `SELECT season_id,
                time_bucket($${baseParams.length + 1}::interval, ts) AS bucket,
                count(*)::int AS n,
                (array_agg(ts           ORDER BY ts ASC))[1]            AS first_ts,
                (array_agg(ts           ORDER BY ts DESC))[1]           AS last_ts,
                (array_agg(ts           ORDER BY arcana_score ASC))[1]  AS min_ts,
                (array_agg(ts           ORDER BY arcana_score DESC))[1] AS max_ts,
                (array_agg(arcana_score ORDER BY ts ASC))[1]            AS first_v,
                (array_agg(arcana_score ORDER BY ts DESC))[1]           AS last_v,
                min(arcana_score)                                       AS min_v,
                max(arcana_score)                                       AS max_v
           FROM score_snapshots WHERE ${where}
          GROUP BY season_id, bucket
          ORDER BY bucket ASC`,
        [...baseParams, toInterval(resolution.bucket as string)],
      );
      const all: SeriesPoint[] = [];
      for (const r of rows) all.push(...this.expandBucket(r.season_id, [], r, 'arcana_score'));
      all.sort((a, b) => a.ts.localeCompare(b.ts));
      total = all.length;
      points = all.slice((page - 1) * pageSize, page * pageSize);
    }

    const seasonIds = [...new Set(points.map((p) => p.season_id))];
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      series: 'score',
      ...part,
      unranked_note: part.ranked
        ? undefined
        : `This agent has ${part.decisions} decision(s), below the ${MIN_DECISIONS} needed to be ranked. ` +
          'Points below are real but the agent holds no rank — absence of a record, not a record of zero.',
      resolution,
      range: { from: q.from ?? totalRow[0]?.first_ts ?? null, to: q.to ?? totalRow[0]?.last_ts ?? null },
      page,
      page_size: pageSize,
      page_size_clamped: clamped || undefined,
      total_points: total,
      total_pages: Math.max(Math.ceil(total / pageSize), 1),
      stored_points: totalPoints,
      seasons: await this.seasonIndex(agentId, seasonIds),
      points,
    };
  }

  // --- NAV series -----------------------------------------------------------

  async navSeries(agentId: string, q: SeriesQueryDto) {
    const agent = await this.loadAgent(agentId);
    const part = await this.participation(agentId);
    const { page, pageSize, clamped } = this.paging(q, SERIES_PAGE_SIZE_DEFAULT, SERIES_PAGE_SIZE_MAX);

    // portfolio_snapshots carries no season_id; portfolios does, one row per
    // (agent, season). The join is what gives every NAV point a season.
    const baseParams: unknown[] = [agentId];
    let filter = '';
    if (q.season_id) {
      baseParams.push(q.season_id);
      filter += ` AND p.season_id = $${baseParams.length}`;
    }
    if (q.from) {
      baseParams.push(q.from);
      filter += ` AND ps.ts >= $${baseParams.length}`;
    }
    if (q.to) {
      baseParams.push(q.to);
      filter += ` AND ps.ts <= $${baseParams.length}`;
    }
    const from = `portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
                  WHERE p.agent_id = $1${filter}`;

    const totalRow = await this.db.query(
      `SELECT count(*)::int AS n, min(ps.ts) AS first_ts, max(ps.ts) AS last_ts FROM ${from}`,
      baseParams,
    );
    const totalPoints: number = totalRow[0]?.n ?? 0;

    const countBuckets = async (interval: string) => {
      const r = await this.db.query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM ${from}
            GROUP BY p.season_id, time_bucket($${baseParams.length + 1}::interval, ps.ts)
         ) t`,
        [...baseParams, interval],
      );
      return r[0]?.n ?? 0;
    };

    const resolution = await this.chooseResolution(q.resolution, totalPoints, pageSize, countBuckets);

    let points: SeriesPoint[];
    let total: number;

    if (resolution.mode === 'raw') {
      total = totalPoints;
      const rows = await this.db.query(
        `SELECT ps.ts, p.season_id, ps.nav, ps.cash,
                -- POSITIONS, NOT KEYS. Counting keys meant a wei of residue
                -- left behind by an exit showed on the chart as a position the
                -- agent was still carrying: the run that went flat at 06:01 on
                -- 2026-09-11 read as holdings_count 1. The floor is DUST_FLOOR
                -- in src/common/positions.ts, which is the precision of
                -- decisions.quantity rather than a chosen cutoff.
                (SELECT count(*) FROM jsonb_each_text(COALESCE(ps.holdings, '{}'::jsonb)) kv
                  WHERE kv.value ~ '^-?[0-9.eE+-]+$' AND kv.value::float8 >= 1e-8)::int AS holdings_count
           FROM ${from}
          ORDER BY ps.ts ASC
          LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
        [...baseParams, pageSize, (page - 1) * pageSize],
      );
      points = rows.map((r: any) => ({
        ts: new Date(r.ts).toISOString(),
        season_id: r.season_id,
        agg: 'raw' as const,
        nav: numeric(r.nav),
        cash: numeric(r.cash),
        holdings_count: numeric(r.holdings_count),
      }));
    } else {
      const rows = await this.db.query(
        `SELECT p.season_id AS season_id,
                time_bucket($${baseParams.length + 1}::interval, ps.ts) AS bucket,
                count(*)::int AS n,
                (array_agg(ps.ts  ORDER BY ps.ts ASC))[1]      AS first_ts,
                (array_agg(ps.ts  ORDER BY ps.ts DESC))[1]     AS last_ts,
                (array_agg(ps.ts  ORDER BY ps.nav ASC))[1]     AS min_ts,
                (array_agg(ps.ts  ORDER BY ps.nav DESC))[1]    AS max_ts,
                (array_agg(ps.nav ORDER BY ps.ts ASC))[1]      AS first_v,
                (array_agg(ps.nav ORDER BY ps.ts DESC))[1]     AS last_v,
                min(ps.nav)                                    AS min_v,
                max(ps.nav)                                    AS max_v
           FROM ${from}
          GROUP BY p.season_id, bucket
          ORDER BY bucket ASC`,
        [...baseParams, toInterval(resolution.bucket as string)],
      );
      const all: SeriesPoint[] = [];
      for (const r of rows) {
        for (const pt of this.expandBucket(r.season_id, [], r, 'nav')) all.push(pt);
      }
      all.sort((a, b) => a.ts.localeCompare(b.ts));
      total = all.length;
      points = all.slice((page - 1) * pageSize, page * pageSize);
    }

    const seasonIds = [...new Set(points.map((p) => p.season_id))];
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      series: 'nav',
      ...part,
      unranked_note: part.ranked
        ? undefined
        : `This agent has ${part.decisions} decision(s), below the ${MIN_DECISIONS} needed to be ranked.`,
      resolution,
      range: { from: q.from ?? totalRow[0]?.first_ts ?? null, to: q.to ?? totalRow[0]?.last_ts ?? null },
      page,
      page_size: pageSize,
      page_size_clamped: clamped || undefined,
      total_points: total,
      total_pages: Math.max(Math.ceil(total / pageSize), 1),
      stored_points: totalPoints,
      seasons: await this.seasonIndex(agentId, seasonIds),
      points,
    };
  }

  // --- decision log ---------------------------------------------------------

  /**
   * The Verified Decision History (§5): what the agent did, and the evidence of
   * the market it did it in.
   *
   * Every row carries `market_snapshot_ref` and `content_hash` — the immutable
   * object the decision was made against — plus the price of the traded symbol
   * at that tick, resolved from that object. A trade list without the prices
   * behind it is a claim; with them it is auditable.
   */
  async decisions(agentId: string, q: DecisionsQueryDto) {
    const agent = await this.loadAgent(agentId);
    const part = await this.participation(agentId);
    const { page, pageSize, clamped } = this.paging(q, DECISIONS_PAGE_SIZE_DEFAULT, DECISIONS_PAGE_SIZE_MAX);

    const params: unknown[] = [agentId];
    let where = `d.agent_id = $1`;
    if (q.season_id) { params.push(q.season_id); where += ` AND d.season_id = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` AND d.ts >= $${params.length}`; }
    if (q.to) { params.push(q.to); where += ` AND d.ts <= $${params.length}`; }
    if (q.action) { params.push(q.action); where += ` AND d.action = $${params.length}`; }
    if (q.symbol) { params.push(q.symbol.toUpperCase()); where += ` AND upper(d.symbol) = $${params.length}`; }

    const totalRow = await this.db.query(
      `SELECT count(*)::int AS n FROM decisions d WHERE ${where}`,
      params,
    );
    const total: number = totalRow[0]?.n ?? 0;

    const rows = await this.db.query(
      `SELECT d.ts, d.season_id, d.action, d.symbol, d.quantity,
              d.resulting_allocation, d.rationale, d.market_snapshot_ref,
              ms.content_hash, ms.source, ms.ingest_mode, ms.trading_date, ms.tick_time
         FROM decisions d
         LEFT JOIN market_snapshots ms ON ms.ref = d.market_snapshot_ref
        WHERE ${where}
        ORDER BY d.ts DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const includePrices = q.include_prices !== 'false';
    let priceLookup: Awaited<ReturnType<MarketPriceClient['lookup']>> | null = null;
    if (includePrices && rows.length > 0) {
      const refs = [...new Set(rows.map((r: any) => r.market_snapshot_ref).filter(Boolean))] as string[];
      priceLookup = await this.prices.lookup(refs);
    }

    const items = rows.map((r: any) => {
      const ref: string = r.market_snapshot_ref;
      const entry = priceLookup?.snapshots?.[ref];
      let price: number | null = null;
      let priceStatus: string;

      if (!includePrices) {
        priceStatus = 'not_requested';
      } else if (!priceLookup || priceLookup.available === false) {
        // market-data could not be reached. The trade is still shown, but the
        // price is explicitly UNKNOWN rather than absent — the same choice the
        // entitlement client makes with status 'unknown' instead of guessing.
        priceStatus = 'unavailable';
      } else if (!entry) {
        priceStatus = 'snapshot_missing';
      } else if (r.symbol && entry.prices?.[r.symbol] !== undefined) {
        price = entry.prices[r.symbol];
        priceStatus = 'resolved';
      } else {
        priceStatus = r.symbol ? 'symbol_not_in_snapshot' : 'no_symbol';
      }

      return {
        ts: new Date(r.ts).toISOString(),
        season_id: r.season_id,
        action: r.action,
        symbol: r.symbol,
        quantity: numeric(r.quantity),
        price,
        price_status: priceStatus,
        notional: price != null && r.quantity != null ? Number((price * Number(r.quantity)).toFixed(2)) : null,
        rationale: r.rationale,
        resulting_allocation: r.resulting_allocation,
        evidence: {
          market_snapshot_ref: ref,
          content_hash: r.content_hash ?? null,
          source: r.source ?? null,
          ingest_mode: r.ingest_mode ?? null,
          trading_date: r.trading_date ?? null,
          tick_time: r.tick_time ? new Date(r.tick_time).toISOString() : null,
          snapshot_url: ref ? `/v1/market/snapshots/${encodeURIComponent(ref)}` : null,
        },
      };
    });

    const seasonIds = [...new Set(items.map((i: { season_id: string }) => i.season_id))] as string[];
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      series: 'decisions',
      ...part,
      unranked_note: part.ranked
        ? undefined
        : `This agent has ${part.decisions} decision(s), below the ${MIN_DECISIONS} needed to be ranked.`,
      prices: includePrices
        ? {
            status: priceLookup?.available === false ? 'unavailable' : 'resolved',
            reason: priceLookup?.reason ?? null,
            missing_refs: priceLookup?.missing ?? [],
          }
        : { status: 'not_requested', reason: null, missing_refs: [] },
      page,
      page_size: pageSize,
      page_size_clamped: clamped || undefined,
      total_decisions: total,
      total_pages: Math.max(Math.ceil(total / pageSize), 1),
      seasons: await this.seasonIndex(agentId, seasonIds),
      decisions: items,
    };
  }
}
