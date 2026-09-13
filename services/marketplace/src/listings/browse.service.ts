import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The marketplace grid and one listing's detail page, assembled once, in SQL.
 *
 * WHY THIS EXISTS AT ALL. `discover()` returns seven columns, and the
 * marketplace the design asks for needs fourteen: return, maximum drawdown, a
 * sparkline, a subscriber count, the creator's handle, whether the agent is
 * still trading, and — the one that matters most — whether this listing can
 * actually be bought. The page that had to render from seven columns printed a
 * paragraph explaining which four numbers it could not show. That paragraph was
 * the bug. The data was always there; nothing had gone and got it.
 *
 * THE SCORE COMES FROM THE LEADERBOARD, NOT FROM score_snapshots.
 *
 * This is not a plumbing preference. The leaderboard WITHHOLDS a score from an
 * agent that has not competed enough — `ranked: false`, and the reason beside
 * it — while `score_snapshots` happily holds a number for that same agent. A
 * grid reading the snapshot table directly would print 61.3 next to an agent
 * the leaderboard refuses to place, and the two surfaces would disagree about
 * whether the agent has a score at all. So the commercial facts come from here
 * and every scoring fact comes from the service that owns the definition.
 *
 * RETURN AND DRAWDOWN ARE ASKED FOR, NOT RECOMPUTED. They are a running-peak
 * window function over portfolio_snapshots, and agent-service already publishes
 * them at /v1/leaderboard/series for exactly this purpose. Writing that window
 * a second time here would give the platform two definitions of "drawdown"
 * which agree until the day one of them is edited — the same reasoning the
 * quote proxy in ListingsService is built on.
 *
 * AND WHEN agent-service CANNOT BE REACHED, the rows still come back, with
 * `performance.available: false` and the reason. A listing whose performance is
 * unknown is not a listing with a return of zero, and it is certainly not a
 * listing that should vanish from the marketplace because a second service
 * blinked.
 */

/** Why a listing cannot be bought right now. `null` means it can. */
type Unbuyable =
  | 'listing_inactive'
  | 'creator_has_no_wallet'
  | 'agent_retired'
  | 'agent_paused'
  | 'agent_draft'
  | null;

const WHY: Record<Exclude<Unbuyable, null>, string> = {
  listing_inactive:
    'This listing is switched off by its creator. It is not on sale.',
  creator_has_no_wallet:
    "This agent's creator has no wallet address on record, so there is no address a buyer could pay " +
    'and none the platform could verify a payment against. Money sent anyway would be unrecoverable ' +
    'and would grant nothing.',
  agent_retired:
    'This agent has been retired. It no longer makes decisions, so a subscription would mirror nothing ' +
    'into your wallet.',
  agent_paused:
    'This agent is paused. It is not making decisions right now, so a subscription bought today would ' +
    'mirror nothing until its creator resumes it.',
  agent_draft:
    'This agent has never been started. There is no record to subscribe to.',
};

type LeaderRow = {
  agent_id: string;
  rank: number | null;
  score: number | null;
  ranked: boolean;
  unranked_note: string | null;
  scores?: Record<string, number | null>;
};

type SeriesRow = {
  agent_id: string;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  age_days: number | null;
  points: number;
  series: Array<{ ts: string; nav: number; agg: 'min' | 'max' }>;
};

export type BrowseSort = 'score' | 'return' | 'price' | 'newest';
const SORTS: BrowseSort[] = ['score', 'return', 'price', 'newest'];

type Lookup<T> = { available: boolean; reason: string | null; byAgent: Map<string, T> };

@Injectable()
export class BrowseService {
  private readonly logger = new Logger(BrowseService.name);
  private readonly agentUrl: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.agentUrl = config.get<string>('AGENT_SERVICE_URL') ?? 'http://127.0.0.1:3001';
  }

  /**
   * Every listing, with the facts a buyer decides on.
   *
   * INACTIVE LISTINGS ARE RETURNED TOO, flagged rather than filtered. An empty
   * grid has at least three meanings — nobody has listed an agent, listings
   * exist and are switched off, or every listed creator is unpayable — and a
   * query that silently drops two of them leaves the page unable to say which
   * happened. The caller asks for `buyable_only=true` when it wants only the
   * sellable ones; the counts are reported either way.
   */
  async browse(opts: {
    q?: string;
    strategy?: string;
    universe?: string;
    minScore?: number;
    maxPrice?: number;
    sort?: string;
    buyableOnly?: boolean;
  }) {
    const rows: Array<Record<string, any>> = await this.db.query(
      `
      WITH subs AS (
        -- Subscriber counts per listing, by the status the row actually holds.
        -- Counted here rather than inferred from payment_claims: a claim is a
        -- payment, a subscription is access, and a renewal is one more claim
        -- against the same access.
        SELECT listing_id,
               count(*) FILTER (WHERE status = 'active')::int AS active,
               count(*) FILTER (WHERE status = 'grace')::int  AS grace,
               count(*)::int                                  AS ever
          FROM subscriptions
         WHERE listing_id IS NOT NULL
         GROUP BY listing_id
      )
      SELECT l.id::text                 AS listing_id,
             l.agent_id::text           AS agent_id,
             l.access_type,
             l.price_usd::float8        AS price_usd,
             l.arca_gate_amount::float8 AS arca_gate_amount,
             l.revenue_share_creator::float8 AS revenue_share_creator,
             l.active,
             a.name                     AS agent_name,
             a.version                  AS agent_version,
             a.status                   AS agent_status,
             a.strategy_type,
             a.asset_universe,
             a.created_at               AS agent_created_at,
             a.provenance,
             c.id::text                 AS creator_id,
             c.handle                   AS creator_handle,
             c.wallet_address           AS creator_wallet,
             coalesce(s.active, 0)      AS subs_active,
             coalesce(s.grace, 0)       AS subs_grace,
             coalesce(s.ever, 0)        AS subs_ever
        FROM marketplace_listings l
        JOIN agents a ON a.id = l.agent_id
        LEFT JOIN creators c ON c.id = a.creator_id
        LEFT JOIN subs s ON s.listing_id = l.id
       -- The same provenance rule every other public surface applies: a row
       -- created by a verification run is not a product somebody can buy.
       WHERE a.provenance = 'live'
       ORDER BY a.created_at DESC, l.id DESC`,
    );

    const [leader, series] = await Promise.all([this.leaderboard(), this.series()]);

    let items = rows.map((r) => this.shape(r, leader, series));

    const counts = {
      listings: items.length,
      buyable: items.filter((i) => i.buyable).length,
      inactive: items.filter((i) => !i.active).length,
      active_but_unbuyable: items.filter((i) => i.active && !i.buyable).length,
      creators_without_wallet: items.filter((i) => i.not_buyable_because === 'creator_has_no_wallet').length,
    };

    // FILTERS, applied to the assembled row because two of the fields they act
    // on (score, return) come from another service. Applied HERE rather than in
    // the browser, which is the rule that matters: the page prints the array in
    // the order and the membership it arrives in.
    const q = (opts.q ?? '').trim().toLowerCase();
    if (q) {
      items = items.filter(
        (i) =>
          (i.agent_name ?? '').toLowerCase().includes(q) ||
          (i.creator?.handle ?? '').toLowerCase().includes(q),
      );
    }
    if (opts.strategy) items = items.filter((i) => i.strategy_type === opts.strategy);
    if (opts.universe) items = items.filter((i) => i.asset_universe === opts.universe);
    if (typeof opts.minScore === 'number') {
      // An agent with NO score is excluded by a score floor rather than treated
      // as scoring zero. "Withheld" does not satisfy "at least 60", and it does
      // not fail it either — it is not a number, so the filter cannot speak
      // about it. The count of what the floor could not judge is reported.
      items = items.filter((i) => typeof i.score === 'number' && i.score >= (opts.minScore as number));
    }
    if (typeof opts.maxPrice === 'number') {
      items = items.filter((i) => typeof i.price_usd === 'number' && i.price_usd <= (opts.maxPrice as number));
    }
    if (opts.buyableOnly === true) items = items.filter((i) => i.buyable);

    const sort: BrowseSort = SORTS.includes(opts.sort as BrowseSort) ? (opts.sort as BrowseSort) : 'score';
    const needsAgentService = sort === 'score' || sort === 'return';
    const sortable = needsAgentService ? (sort === 'score' ? leader.available : series.available) : true;
    const missing = items.filter((i) => this.sortKey(i, sort) === null).length;
    if (sortable) items = this.sorted(items, sort);

    return {
      sort,
      sorted: sortable,
      sort_note: sortable
        ? this.sortNote(sort)
        : 'This ordering needs figures from agent-service, which could not be read, so the rows are in ' +
          'listing order instead. They are NOT ordered by the field that was asked for, and saying so ' +
          'is better than presenting an arbitrary order as a ranking.',
      // A row with no value for the sort field sinks to the end rather than
      // being scored as zero; this says how many did.
      unsortable_rows: sortable ? missing : null,
      counts,
      facets: this.facets(rows),
      performance_source: series.available
        ? 'agent-service /v1/leaderboard/series — return and drawdown measured inside the current season, from a running peak'
        : null,
      performance_unavailable_reason: series.available ? null : series.reason,
      scoring_source: leader.available
        ? 'agent-service /v1/leaderboard — the published score, WITHHELD rather than lowered for an agent that has not competed enough'
        : null,
      scoring_unavailable_reason: leader.available ? null : leader.reason,
      items,
      as_of: new Date().toISOString(),
    };
  }

  /** One listing, with everything the detail page states before a buyer pays. */
  async detail(listingId: string) {
    const rows: Array<Record<string, any>> = await this.db.query(
      `SELECT l.id::text AS listing_id, l.agent_id::text AS agent_id, l.access_type,
              l.price_usd::float8 AS price_usd,
              l.arca_gate_amount::float8 AS arca_gate_amount,
              l.revenue_share_creator::float8 AS revenue_share_creator,
              l.active,
              a.name AS agent_name, a.version AS agent_version, a.status AS agent_status,
              a.strategy_type, a.asset_universe, a.created_at AS agent_created_at,
              -- TWO DIFFERENT THINGS, AND THEY LIVE IN TWO PLACES.
              --
              -- agents.risk_profile is what the creator DECLARED: the limits
              -- that size positions. agent_dna.risk_personality is what the
              -- platform MEASURED the agent doing. Reading the second and
              -- calling it the first is how a buyer ends up shown observed
              -- behaviour under the heading "the limits this will trade under"
              -- — and it is what this query did on its first run, which failed
              -- loudly because the column is not on the agents table at all.
              a.provenance, a.mandate, a.risk_profile,
              d.risk_personality, d.computed_at AS dna_computed_at,
              c.id::text AS creator_id, c.handle AS creator_handle,
              c.wallet_address AS creator_wallet,
              (SELECT count(*) FILTER (WHERE status = 'active') FROM subscriptions WHERE listing_id = l.id)::int AS subs_active,
              (SELECT count(*) FILTER (WHERE status = 'grace')  FROM subscriptions WHERE listing_id = l.id)::int AS subs_grace,
              (SELECT count(*) FROM subscriptions WHERE listing_id = l.id)::int AS subs_ever
         FROM marketplace_listings l
         JOIN agents a ON a.id = l.agent_id
         LEFT JOIN agent_dna d ON d.agent_id = a.id
         LEFT JOIN creators c ON c.id = a.creator_id
        WHERE l.id = $1`,
      [listingId],
    );
    if (rows.length === 0) throw new NotFoundException(`Listing ${listingId} not found`);
    const r = rows[0];

    const [leader, series] = await Promise.all([this.leaderboard(), this.series()]);
    const base = this.shape(r, leader, series);

    // THE SMALLEST PROTECTIVE LEVEL THIS AGENT'S POOL WILL ACCEPT, stated
    // before purchase because it is the number that decides whether a buyer's
    // own stop can be armed at all — and an unarmable stop discovered after the
    // first tick is discovered too late.
    const pool: Array<{ min_acceptable_pct: number | null }> = await this.db.query(
      `SELECT min_acceptable_pct::float8 AS min_acceptable_pct
         FROM position_guards
        WHERE agent_id = $1 AND min_acceptable_pct IS NOT NULL
        ORDER BY set_at DESC LIMIT 1`,
      [r.agent_id],
    );
    const minFrac = pool[0]?.min_acceptable_pct ?? null;

    // The symbols this agent has actually traded, which is a different claim
    // from the universe it is allowed to trade — and the one a buyer cares
    // about, because it is what will appear in their wallet.
    const symbols: Array<{ symbol: string; decisions: number }> = await this.db.query(
      `SELECT symbol, count(*)::int AS decisions
         FROM decisions_counted
        WHERE agent_id = $1 AND symbol IS NOT NULL AND symbol <> ''
        GROUP BY symbol ORDER BY count(*) DESC LIMIT 24`,
      [r.agent_id],
    );

    return {
      ...base,
      mandate: r.mandate ?? null,
      // WHAT THE CREATOR DECLARED. Labelled as the creator's own sizing: it
      // describes what the agent does in ITS wallet. A subscriber's positions
      // are sized by the subscriber's own limits, which is the whole point of
      // mirroring rather than copying a portfolio.
      risk_profile: r.risk_profile ?? null,
      risk_note:
        'These limits size the agent in ITS OWN wallet. In yours, your own limits apply — the creator ' +
        'chooses only the direction.',
      // WHAT THE PLATFORM MEASURED IT DOING. Kept separate from the declared
      // limits on purpose: the distance between the two is the whole content of
      // the strategy multiplier, and collapsing them would let a mislabelled
      // agent present its own description as evidence.
      risk_personality: r.risk_personality ?? null,
      risk_personality_computed_at: r.dna_computed_at ? new Date(r.dna_computed_at).toISOString() : null,
      risk_personality_note:
        r.risk_personality
          ? 'Measured from this agent’s own decision log — what it did, not what it said it would do.'
          : 'No behavioural DNA has been computed for this agent yet, so there is nothing measured to set ' +
            'against what it declared. That is an absent measurement, not agreement.',
      traded_symbols: symbols.map((s) => ({ symbol: s.symbol, decisions: Number(s.decisions) })),
      traded_symbols_note:
        'Symbols this agent has actually recorded a decision on, not the universe it is permitted to ' +
        'trade. The two are different claims.',
      pool_minimum_fraction: minFrac,
      pool_minimum_percent: minFrac === null ? null : Number((minFrac * 100).toFixed(4)),
      pool_minimum_note:
        minFrac === null
          ? 'No guard on this agent has recorded a pool minimum, so the smallest protective level a ' +
            'subscriber could arm is not known from the record. That is unknown, not zero.'
          : 'The smallest stop-loss fraction this pool has accepted. Anything tighter is refused, which ' +
            'leaves the position with nothing watching it between ticks.',
      revenue_share_creator: r.revenue_share_creator ?? null,
    };
  }

  // ---------------------------------------------------------------- shaping

  private shape(
    r: Record<string, any>,
    leader: Lookup<LeaderRow>,
    series: Lookup<SeriesRow>,
  ) {
    const lb = leader.byAgent.get(r.agent_id) ?? null;
    const sr = series.byAgent.get(r.agent_id) ?? null;

    const why = this.unbuyable(r);
    const price = r.price_usd === null || r.price_usd === undefined ? null : Number(r.price_usd);

    return {
      listing_id: r.listing_id,
      agent_id: r.agent_id,
      agent_name: r.agent_name ?? null,
      agent_version: r.agent_version ?? null,
      agent_status: r.agent_status ?? null,
      strategy_type: r.strategy_type ?? null,
      asset_universe: r.asset_universe ?? null,
      agent_created_at: r.agent_created_at ? new Date(r.agent_created_at).toISOString() : null,
      creator: r.creator_id
        ? { id: r.creator_id, handle: r.creator_handle ?? null, has_wallet: !!r.creator_wallet }
        : null,
      access_type: r.access_type ?? null,
      price_usd: price,
      arca_gate_amount: r.arca_gate_amount === null ? null : Number(r.arca_gate_amount),
      active: r.active === true,
      buyable: why === null,
      not_buyable_because: why,
      not_buyable_note: why ? WHY[why] : null,
      subscribers: {
        active: Number(r.subs_active ?? 0),
        grace: Number(r.subs_grace ?? 0),
        ever: Number(r.subs_ever ?? 0),
      },
      // SCORE AND RANK AS THE LEADERBOARD PUBLISHES THEM — including its
      // refusal to publish one. `score: null` with `ranked: false` and a reason
      // is a different statement from a low score, and a card has to be able to
      // tell the two apart.
      score: lb?.ranked ? lb.score : null,
      rank: lb?.rank ?? null,
      ranked: lb ? lb.ranked : null,
      unranked_note: lb?.unranked_note ?? null,
      scoring_known: leader.available,
      absent_from_leaderboard: leader.available && !lb,
      performance: series.available
        ? {
            available: true,
            reason: null,
            measured: !!sr,
            return_pct: sr?.return_pct ?? null,
            max_drawdown_pct: sr?.max_drawdown_pct ?? null,
            age_days: sr?.age_days ?? null,
            points: sr?.points ?? 0,
            // ALREADY DOWNSAMPLED min/max per bucket by the service that owns
            // the series. Anything drawing this plots it as it arrives.
            series: sr?.series ?? [],
            note: sr
              ? null
              : 'This agent has no portfolio snapshot in the current season, so its return and drawdown ' +
                'are not measured. That is an absent measurement, not a flat line at zero.',
          }
        : {
            available: false,
            reason: series.reason,
            measured: false,
            return_pct: null,
            max_drawdown_pct: null,
            age_days: null,
            points: 0,
            series: [],
            note: null,
          },
    };
  }

  private unbuyable(r: Record<string, any>): Unbuyable {
    // ORDER MATTERS: the first reason is the one shown, and the most decisive
    // one comes first. A creator with no payee address stays unbuyable however
    // active the listing is, so saying "switched off" there would send the
    // creator to flip a switch that changes nothing.
    if (!r.creator_wallet) return 'creator_has_no_wallet';
    if (r.agent_status === 'retired') return 'agent_retired';
    if (r.agent_status === 'draft') return 'agent_draft';
    if (!r.active) return 'listing_inactive';
    if (r.agent_status === 'paused') return 'agent_paused';
    return null;
  }

  private facets(rows: Array<Record<string, any>>) {
    const count = (key: string) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const v = r[key];
        if (!v) continue;
        m.set(v, (m.get(v) ?? 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, listings: n }));
    };
    return { strategy_type: count('strategy_type'), asset_universe: count('asset_universe') };
  }

  private sortKey(i: any, sort: BrowseSort): number | null {
    if (sort === 'score') return typeof i.score === 'number' ? i.score : null;
    if (sort === 'return') return typeof i.performance?.return_pct === 'number' ? i.performance.return_pct : null;
    if (sort === 'price') return typeof i.price_usd === 'number' ? i.price_usd : null;
    return i.agent_created_at ? Date.parse(i.agent_created_at) : null;
  }

  /**
   * Order the assembled rows.
   *
   * A ROW WITH NO VALUE FOR THE SORT FIELD GOES LAST, in either direction, and
   * is never treated as zero. Sorting an unscored agent as 0 would place it
   * below every scored agent when ordering by score, which reads as "it scored
   * worse than all of them" — a claim nobody measured.
   */
  private sorted(items: any[], sort: BrowseSort) {
    const asc = sort === 'price';
    return [...items].sort((a, b) => {
      const ka = this.sortKey(a, sort);
      const kb = this.sortKey(b, sort);
      if (ka === null && kb === null) return (a.listing_id as string).localeCompare(b.listing_id as string);
      if (ka === null) return 1;
      if (kb === null) return -1;
      if (ka === kb) return (a.listing_id as string).localeCompare(b.listing_id as string);
      return asc ? ka - kb : kb - ka;
    });
  }

  private sortNote(sort: BrowseSort): string {
    if (sort === 'score')
      return 'Highest published ARCANA Score first. An agent whose score is withheld is last, not lowest.';
    if (sort === 'return')
      return 'Highest season return first, measured from portfolio snapshots by agent-service.';
    if (sort === 'price') return 'Cheapest listing price first. A listing with no price is last, not free.';
    return 'Most recently created agent first.';
  }

  // -------------------------------------------------------- agent-service

  private async leaderboard(): Promise<Lookup<LeaderRow>> {
    const byAgent = new Map<string, LeaderRow>();
    try {
      const res = await fetch(`${this.agentUrl}/v1/leaderboard?page_size=200&include_unranked=true`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        return { available: false, reason: `agent-service answered ${res.status} for the leaderboard`, byAgent };
      }
      const body = (await res.json()) as { items?: LeaderRow[] };
      for (const it of body.items ?? []) byAgent.set(it.agent_id, it);
      return { available: true, reason: null, byAgent };
    } catch (e) {
      this.logger.warn(`leaderboard unreadable for browse: ${e}`);
      return {
        available: false,
        reason: `agent-service could not be reached (${e instanceof Error ? e.message : String(e)})`,
        byAgent,
      };
    }
  }

  private async series(): Promise<Lookup<SeriesRow>> {
    const byAgent = new Map<string, SeriesRow>();
    try {
      const res = await fetch(`${this.agentUrl}/v1/leaderboard/series?buckets=20`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        return { available: false, reason: `agent-service answered ${res.status} for the NAV series`, byAgent };
      }
      const body = (await res.json()) as { items?: SeriesRow[] };
      for (const it of body.items ?? []) byAgent.set(it.agent_id, it);
      return { available: true, reason: null, byAgent };
    } catch (e) {
      this.logger.warn(`series unreadable for browse: ${e}`);
      return {
        available: false,
        reason: `agent-service could not be reached (${e instanceof Error ? e.message : String(e)})`,
        byAgent,
      };
    }
  }
}
