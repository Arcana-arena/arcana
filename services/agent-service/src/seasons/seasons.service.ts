import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Season } from './season.entity';
import { CreateSeasonDto } from './dto/create-season.dto';
import { UpdateSeasonDto } from './dto/update-season.dto';
import { EntitlementClient, GateStatus } from '../entitlements/entitlement.client';

/** The $ARCA action a Premium Arena's entry is gated on (§2.7). */
export const PREMIUM_ARENA_ACTION = 'premium_arena';

/**
 * What a season costs to enter, as told to anyone browsing arenas.
 *
 * The point of this block is that a user learns an arena needs $ARCA BEFORE
 * registering, not from a 403 afterwards — and, just as importantly, cannot
 * read "premium" as "guarded". `enforced` is the field that carries that: an
 * arena can be marked premium while the gate reads no balance at all, which is
 * exactly the state the platform is in until the token launches. It is the
 * season-listing counterpart of `balance_checked` on an entitlement decision.
 */
export interface SeasonAccess {
  tier: string;
  /** Every $ARCA gate a registration into this arena must pass, in order. */
  gates: string[];
  /** $ARCA required for the premium gate, or null when unset/unread. */
  required_arca: string | null;
  /**
   * Whether entry is ACTUALLY being verified right now. `false` means the gate
   * is wired but passes everyone; `null` means arca-service could not be asked,
   * so this is unknown rather than off.
   */
  enforced: boolean | null;
  note: string;
}

export type SeasonView = Season & { access: SeasonAccess };

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

  async findAll(): Promise<SeasonView[]> {
    const seasons = await this.seasons.find({ order: { startAt: 'DESC' } });
    // One gate lookup for the whole page, not one per season: the threshold is
    // per action, not per arena, so asking once is both cheaper and impossible
    // to render inconsistently across rows.
    const gate = seasons.some((s) => s.accessTier === 'premium')
      ? await this.entitlements.describe(PREMIUM_ARENA_ACTION)
      : null;
    return seasons.map((s) => this.withAccess(s, gate));
  }

  async findOne(id: string): Promise<SeasonView> {
    const season = await this.seasons.findOne({ where: { id } });
    if (!season) {
      throw new NotFoundException(`Season ${id} not found`);
    }
    return this.withAccessAsync(season);
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
    // are unaffected, the same entry-not-tick rule the COMPETE gate follows.
    if (dto.accessTier !== undefined) season.accessTier = dto.accessTier;
    return this.withAccessAsync(await this.seasons.save(season));
  }

  private async withAccessAsync(season: Season): Promise<SeasonView> {
    const gate =
      season.accessTier === 'premium'
        ? await this.entitlements.describe(PREMIUM_ARENA_ACTION)
        : null;
    return this.withAccess(season, gate);
  }

  /**
   * Attach the access block. `gate` is the already-fetched status when the
   * caller batched the lookup; when omitted it is fetched lazily via
   * `withAccessAsync`.
   */
  private withAccess(season: Season, gate?: GateStatus | null): SeasonView {
    if (season.accessTier !== 'premium') {
      return {
        ...season,
        access: {
          tier: season.accessTier,
          // COMPETE applies to every arena, premium or not. Saying so here
          // stops "standard" from reading as "ungated".
          gates: ['compete'],
          required_arca: null,
          enforced: null,
          note:
            'Open arena. Entry needs the platform-wide $ARCA COMPETE entitlement, ' +
            'the same as every other season, and nothing beyond it.',
        },
      };
    }

    const status = gate?.status ?? 'unknown';
    const enforced = status === 'unknown' ? null : status === 'active';
    return {
      ...season,
      access: {
        tier: 'premium',
        // Both, in the order they are checked. A premium arena does not replace
        // the platform-wide gate, it adds a second door behind it.
        gates: ['compete', PREMIUM_ARENA_ACTION],
        required_arca: gate?.required ?? null,
        enforced,
        note:
          enforced === true
            ? `Premium Arena. Entry is verified against a live $ARCA balance: ` +
              `${gate?.required} $ARCA required, on top of the COMPETE entitlement.`
            : enforced === false
              ? 'Premium Arena. The $ARCA premium_arena gate is wired but currently ' +
                'reads no balance (the token is not launched, or no threshold is set), ' +
                'so every registration passes. Marked premium, not yet guarded.'
              : 'Premium Arena. The $ARCA service could not be reached, so whether the ' +
                'gate is currently verifying balances is unknown — not known to be off.',
      },
    };
  }
}
