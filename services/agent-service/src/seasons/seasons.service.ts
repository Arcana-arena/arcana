import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Season } from './season.entity';
import { Page, pageOf } from '../common/pagination';
import { CreateSeasonDto } from './dto/create-season.dto';
import { UpdateSeasonDto } from './dto/update-season.dto';
import { EntitlementClient, GateStatus } from '../entitlements/entitlement.client';

/** The $ARCA action a Premium Arena's entry is gated on (§2.7). */
export const PREMIUM_ARENA_ACTION = 'premium_arena';
/** The platform-wide entry gate, applied to every arena regardless of tier. */
export const COMPETE_ACTION = 'compete';

/** One $ARCA gate standing between an agent and this arena. */
export interface SeasonGate {
  action: string;
  /** `active` reads a live balance, `inactive` admits everyone, `unknown` was unreadable. */
  status: GateStatus['status'];
  /** Threshold in $ARCA, non-null only when the gate is active. */
  required_arca: string | null;
}

/**
 * What a season costs to enter, as told to anyone browsing arenas.
 *
 * Two things this block exists to prevent. First, learning that an arena needs
 * $ARCA from a 403 rather than before registering. Second — and this is the one
 * with teeth — reading "premium" as "guarded". An arena can be marked premium
 * while its gate reads no balance at all, which is exactly the state the
 * platform is in until the token launches.
 *
 * `enforced` carries that, and it is the season-listing counterpart of
 * `balance_checked` on an entitlement decision. It answers one question only:
 * **is entry verified against a real balance right now?** `gates` shows which
 * door is live when the summary is not enough, rather than making the caller
 * infer it from the tier.
 */
export interface SeasonAccess {
  tier: string;
  /** Every $ARCA gate a registration must pass, in the order they are checked. */
  gates: SeasonGate[];
  /**
   * The balance an entrant actually needs — the largest active threshold, since
   * every gate must pass. Null when no gate is currently reading balances.
   */
  required_arca: string | null;
  /**
   * `true` — entry is verified against a live balance.
   * `false` — every gate is wired but admits everyone. Marked, not guarded.
   * `null`  — arca-service could not be reached, so this is UNKNOWN rather
   *           than off. Never collapse the two.
   */
  enforced: boolean | null;
  note: string;
}

/**
 * Where a season is in its life, and how much is in it.
 *
 * WHY THIS IS HERE AND NOT LEFT TO THE CALLER. A list of arenas without these
 * cannot be rendered: "is this one running" and "is anyone in it" are the two
 * questions a browsing page asks first, and answering them from start_at,
 * end_at and a second request per row is how every client ends up deriving
 * them slightly differently.
 *
 * STATUS IS DERIVED, NOT STORED. `seasons` has no status column and should not
 * grow one: a stored status is a second source of truth that drifts the moment
 * an operator moves end_at and forgets, and there is nothing a stored one could
 * say that the dates do not. Archiving a season early is a real product action
 * and would need its own column and its own door — it does not exist yet, and
 * pretending otherwise here would be the silent false this block exists to
 * avoid.
 */
export interface SeasonProgress {
  /** Derived from start_at/end_at against now. */
  status: 'upcoming' | 'running' | 'ended';
  /** Competitions created in this season, whatever their own status. */
  competitions: number;
  /** Distinct agents holding a seat across those competitions. */
  participants: number;
}

export type SeasonView = Season & { access: SeasonAccess; progress: SeasonProgress };

@Injectable()
export class SeasonsService {
  constructor(
    @InjectRepository(Season)
    private readonly seasons: Repository<Season>,
    private readonly entitlements: EntitlementClient,
  ) {}

  async create(dto: CreateSeasonDto): Promise<SeasonView> {
    const season = this.seasons.create({
      name: dto.name,
      universe: dto.universe,
      startAt: new Date(dto.startAt),
      endAt: new Date(dto.endAt),
      ruleset: JSON.parse(dto.ruleset),
      accessTier: dto.accessTier ?? 'standard',
    });
    return this.withAccessAsync(await this.seasons.save(season));
  }

  async findAllPaged(opts: {
    page: number;
    pageSize: number;
    offset: number;
  }): Promise<Page<SeasonView>> {
    const [rows, total] = await this.seasons.findAndCount({
      order: { startAt: 'DESC', id: 'DESC' },
      skip: opts.offset,
      take: opts.pageSize,
    });
    // The gate lookup is per ACTION and covers the whole page, exactly as in
    // findAll() below — paging changes how many rows are rendered, not how
    // many times a threshold has to be asked for.
    const statuses = await this.gateStatuses(rows.some((s) => s.accessTier === 'premium'));
    const counts = await this.countsFor(rows.map((s) => s.id));
    return pageOf(rows.map((s) => this.withAccess(s, statuses, counts)), total, opts.page, opts.pageSize);
  }

  async findAll(): Promise<SeasonView[]> {
    const seasons = await this.seasons.find({ order: { startAt: 'DESC' } });
    // One lookup per ACTION for the whole page, not one per season: a threshold
    // belongs to an action, not to an arena, so asking once is both cheaper and
    // impossible to render inconsistently across rows.
    const statuses = await this.gateStatuses(
      seasons.some((s) => s.accessTier === 'premium'),
    );
    const counts = await this.countsFor(seasons.map((s) => s.id));
    return seasons.map((s) => this.withAccess(s, statuses, counts));
  }

  async findOne(id: string): Promise<SeasonView> {
    return this.withAccessAsync(await this.findEntity(id));
  }

  /** The raw row, for callers that need the tier without the access block. */
  async findEntity(id: string): Promise<Season> {
    const season = await this.seasons.findOne({ where: { id } });
    if (!season) {
      throw new NotFoundException(`Season ${id} not found`);
    }
    return season;
  }

  async update(id: string, dto: UpdateSeasonDto): Promise<SeasonView> {
    const season = await this.findEntity(id);
    if (dto.name !== undefined) season.name = dto.name;
    if (dto.startAt !== undefined) season.startAt = new Date(dto.startAt);
    if (dto.endAt !== undefined) season.endAt = new Date(dto.endAt);
    // Retiering applies to registrations from here on; agents already admitted
    // are unaffected, the same entry-not-per-tick rule the COMPETE gate follows.
    if (dto.accessTier !== undefined) season.accessTier = dto.accessTier;
    return this.withAccessAsync(await this.seasons.save(season));
  }

  /**
   * Competition and participant counts for a page of seasons, in ONE query.
   *
   * Not one query per row: a listing page is the place where an N+1 stops being
   * a style point, and the count belongs to the page rather than to the row.
   *
   * DISTINCT on both sides for a reason. An agent can hold a seat in more than
   * one competition of the same season, and counting seats instead of agents
   * would report more entrants than exist — the number a browsing page shows is
   * "how many agents are in this arena", not "how many rows mention one".
   */
  private async countsFor(seasonIds: string[]): Promise<Record<string, { competitions: number; participants: number }>> {
    if (seasonIds.length === 0) return {};
    const rows: Array<{ season_id: string; competitions: string; participants: string }> =
      await this.seasons.manager.query(
        `SELECT c.season_id::text AS season_id,
                count(DISTINCT c.id)        AS competitions,
                count(DISTINCT p.agent_id)  AS participants
           FROM competitions c
           LEFT JOIN LATERAL unnest(coalesce(c.participant_ids, '{}'::uuid[])) AS p(agent_id) ON true
          WHERE c.season_id = ANY($1::uuid[])
          GROUP BY c.season_id`,
        [seasonIds],
      );
    return Object.fromEntries(
      rows.map((r) => [r.season_id, {
        competitions: Number(r.competitions),
        participants: Number(r.participants),
      }]),
    );
  }

  /** Ask arca-service for each gate's live status. */
  private async gateStatuses(
    includePremium: boolean,
  ): Promise<Record<string, GateStatus>> {
    const actions = includePremium
      ? [COMPETE_ACTION, PREMIUM_ARENA_ACTION]
      : [COMPETE_ACTION];
    const results = await Promise.all(
      actions.map((a) => this.entitlements.describe(a)),
    );
    return Object.fromEntries(results.map((r) => [r.action, r]));
  }

  private async withAccessAsync(season: Season): Promise<SeasonView> {
    return this.withAccess(
      season,
      await this.gateStatuses(season.accessTier === 'premium'),
      await this.countsFor([season.id]),
    );
  }

  private withAccess(
    season: Season,
    statuses: Record<string, GateStatus>,
    counts: Record<string, { competitions: number; participants: number }> = {},
  ): SeasonView {
    const premium = season.accessTier === 'premium';
    const actions = premium
      ? [COMPETE_ACTION, PREMIUM_ARENA_ACTION]
      : [COMPETE_ACTION];

    const gates: SeasonGate[] = actions.map((action) => {
      const s = statuses[action];
      return {
        action,
        status: s?.status ?? 'unknown',
        required_arca: s?.status === 'active' ? s.required : null,
      };
    });

    // Every gate must pass, so what an entrant needs is the LARGEST active
    // threshold. Reporting anything smaller would understate the price of entry.
    const required = gates.reduce<string | null>((max, g) => {
      if (g.required_arca == null) return max;
      if (max == null || Number(g.required_arca) > Number(max)) {
        return g.required_arca;
      }
      return max;
    }, null);

    // `enforced` answers "is entry verified", not "is every gate verified": one
    // live gate is a real balance requirement even if the other is dormant.
    // Unknown only when nothing was confirmed live AND something was unreadable
    // — otherwise a confirmed live gate settles the question on its own.
    const anyActive = gates.some((g) => g.status === 'active');
    const anyUnknown = gates.some((g) => g.status === 'unknown');
    const enforced = anyActive ? true : anyUnknown ? null : false;

    const now = Date.now();
    const status: SeasonProgress['status'] =
      now < season.startAt.getTime() ? 'upcoming'
        : now > season.endAt.getTime() ? 'ended'
          : 'running';
    const n = counts[season.id] ?? { competitions: 0, participants: 0 };

    return {
      ...season,
      progress: { status, competitions: n.competitions, participants: n.participants },
      access: {
        tier: season.accessTier,
        gates,
        required_arca: required,
        enforced,
        note: this.note(premium, enforced, required),
      },
    };
  }

  private note(
    premium: boolean,
    enforced: boolean | null,
    required: string | null,
  ): string {
    const arena = premium
      ? 'Premium Arena: entry needs the $ARCA premium_arena entitlement in addition to ' +
        'the platform-wide COMPETE entitlement.'
      : 'Open arena: entry needs the platform-wide $ARCA COMPETE entitlement and ' +
        'nothing beyond it.';

    if (enforced === true) {
      return `${arena} Verified against a live balance — ${required} $ARCA required.`;
    }
    if (enforced === false) {
      return (
        `${arena} Those gates are wired but currently read no balance (the token is ` +
        'not launched, or no threshold is set), so every registration passes. ' +
        (premium ? 'Marked premium, not yet guarded.' : '')
      ).trim();
    }
    return (
      `${arena} The $ARCA service could not be reached, so whether entry is ` +
      'currently verified against a balance is unknown — not known to be off.'
    );
  }
}
