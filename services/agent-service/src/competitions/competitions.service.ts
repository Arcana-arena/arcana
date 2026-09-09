import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Competition } from './competition.entity';
import { CompetitionTick } from './competition-tick.entity';
import { CreateCompetitionDto } from './dto/create-competition.dto';
import { EntitlementClient } from '../entitlements/entitlement.client';
import { PREMIUM_ARENA_ACTION, SeasonsService } from '../seasons/seasons.service';

/**
 * A saved competition plus how its participants got in.
 *
 * `balance_checked` carries the same meaning it has on an entitlement decision:
 * whether an actual $ARCA balance was read. A registration that succeeded
 * because nothing was checked must not look like one that passed a gate.
 */
export type CompetitionRegistration = Competition & {
  access: {
    tier: string;
    gates_applied: string[];
    balance_checked: boolean;
    note: string;
  };
};

@Injectable()
export class CompetitionsService {
  constructor(
    @InjectRepository(Competition)
    private readonly competitions: Repository<Competition>,
    @InjectRepository(CompetitionTick)
    private readonly ticks: Repository<CompetitionTick>,
    private readonly entitlements: EntitlementClient,
    private readonly seasons: SeasonsService,
  ) {}

  /**
   * Register participants into a competition.
   *
   * Gated on the $ARCA COMPETE entitlement (§2.7), once per participant — and,
   * when the season is a **Premium Arena**, on the PREMIUM_ARENA entitlement as
   * well. See docs/premium-arena.md.
   *
   * BOTH gates, not one replacing the other. They answer different questions:
   * COMPETE is "may this actor compete on ARCANA at all", a platform-wide
   * floor; PREMIUM_ARENA is "may it enter this restricted environment". Letting
   * the premium gate stand in for COMPETE would only be safe if the premium
   * threshold were always the larger number, and nothing enforces that — with
   * ARCA_GATE_PREMIUM_ARENA=10 against ARCA_GATE_COMPETE=100 a premium arena
   * would become the CHEAPEST way in, a hole opened by configuration alone.
   * Requiring both makes the effective requirement max(compete, premium)
   * without needing that invariant to hold, and keeps the two refusals
   * distinguishable: "you may not enter this arena" is not "you may not
   * compete", and the two have different remedies.
   *
   * Checked at registration, NOT per tick. A tick is the platform running an
   * agent it already admitted; re-checking every minute would put an external
   * HTTP call in the competition loop and let an arca-service outage halt a
   * running season. That holds for the premium gate too — an arena does not
   * eject an agent mid-season because a balance moved.
   *
   * Today every check passes without reading a balance, because the token has
   * not launched. The returned `access` block says so rather than letting a
   * successful registration imply a verified entitlement.
   */
  async create(dto: CreateCompetitionDto): Promise<CompetitionRegistration> {
    // Read the arena first: its tier decides which gates apply, so a season
    // that does not exist fails here rather than at the foreign key.
    const season = await this.seasons.findEntity(dto.seasonId);
    const premium = season.accessTier === 'premium';

    // Starts true and is falsified by any check that admitted without reading
    // a balance. "Every gate verified" is the claim that needs evidence; one
    // unverified pass is enough to withdraw it.
    let allVerified = true;
    for (const participantId of dto.participantIds ?? []) {
      const wallet = await this.entitlements.walletForAgent(participantId);
      const compete = await this.entitlements.require(
        'compete',
        wallet,
        `register agent ${participantId} into a competition`,
      );
      if (!compete.balance_checked) allVerified = false;

      if (premium) {
        const arena = await this.entitlements.require(
          PREMIUM_ARENA_ACTION,
          wallet,
          `register agent ${participantId} into the premium arena "${season.name}"`,
        );
        if (!arena.balance_checked) allVerified = false;
      }
    }

    const competition = this.competitions.create({
      seasonId: dto.seasonId,
      type: dto.type,
      participantIds: dto.participantIds,
      status: 'pending',
    });
    const saved = await this.competitions.save(competition);

    return {
      ...saved,
      access: {
        tier: season.accessTier,
        gates_applied: premium ? ['compete', PREMIUM_ARENA_ACTION] : ['compete'],
        balance_checked: allVerified,
        note: allVerified
          ? 'Every participant was admitted against a verified $ARCA balance.'
          : 'Admitted, but at least one gate passed WITHOUT reading a balance (the ' +
            'token is not launched, or no threshold is set for that action). This is ' +
            'a pass by default, not a verified entitlement.',
      },
    };
  }

  findAll(): Promise<Competition[]> {
    return this.competitions.find({ order: { id: 'DESC' } });
  }

  async findOne(id: string): Promise<Competition> {
    const competition = await this.competitions.findOne({ where: { id } });
    if (!competition) {
      throw new NotFoundException(`Competition ${id} not found`);
    }
    return competition;
  }

  async findBySeason(seasonId: string): Promise<Competition[]> {
    return this.competitions.find({ where: { seasonId } });
  }

  /**
   * Open the next decision round for a competition.
   *
   * REFUSES A BACKFILL SNAPSHOT. This is the structural half of the
   * backfill/replay rule (docs/market-data.md). Backfilled snapshots hold real
   * vendor prices and are wanted — they give `/previous` something to compare
   * against and Agent DNA months of depth it would otherwise wait for — but
   * their outcome was already knowable when they were fetched. A season run
   * over them is a backtest: the operator can re-run it until it looks good,
   * and §5's "decisions are recorded before the outcome is known" quietly stops
   * being true in the one place the platform's whole claim rests on.
   *
   * Enforced here rather than left to discipline because discipline is exactly
   * what failed the last time this codebase relied on it — the snapshot/decision
   * retention rule was a convention until it was broken, and became a foreign
   * key (0019). The production scheduler cannot even ask for a historical
   * session, so this guard catches the other routes in: a manual call, a script,
   * or a future replay feature that forgets.
   */
  async openTick(
    competitionId: string,
    marketSnapshotRef: string,
  ): Promise<CompetitionTick> {
    const competition = await this.findOne(competitionId);
    if (competition.status === 'completed') {
      throw new BadRequestException('Competition is completed');
    }

    const snapshot = await this.competitions.manager.query(
      // trading_date is cast in SQL rather than formatted in JS: the driver
      // hands back a Date, whose default string form carries the SERVER's
      // timezone ("Fri Sep 04 2026 00:00:00 GMT+0700") into a message about a
      // US market session. The session date is a calendar fact, not an instant.
      `SELECT ingest_mode, source, to_char(trading_date, 'YYYY-MM-DD') AS trading_date
         FROM market_snapshots WHERE ref = $1`,
      [marketSnapshotRef],
    );
    if (snapshot.length === 0) {
      throw new BadRequestException(
        `Market snapshot ${marketSnapshotRef} does not exist`,
      );
    }
    if (snapshot[0].ingest_mode === 'backfill') {
      throw new BadRequestException(
        `Snapshot ${marketSnapshotRef} is a backfill of ${snapshot[0].trading_date}, ` +
          'whose outcome was already known when it was fetched. A scored season runs ' +
          'forward only — backfilled sessions provide price history, never decisions. ' +
          'See docs/market-data.md.',
      );
    }

    // Find an already-open tick (do not double-open).
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    if (open) {
      throw new BadRequestException(
        `Tick ${open.tickIndex} is already open for this competition`,
      );
    }

    const max = await this.ticks
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.tickIndex), -1)', 'max')
      .where('t.competitionId = :cid', { cid: competitionId })
      .getRawOne<{ max: string }>();

    const tick = this.ticks.create({
      competitionId,
      tickIndex: Number(max?.max ?? -1) + 1,
      phase: 'open',
      marketSnapshotRef,
      windowStart: new Date(),
    });
    const saved = await this.ticks.save(tick);

    if (competition.status === 'pending') {
      competition.status = 'running';
      await this.competitions.save(competition);
    }
    return saved;
  }

  /** Close the currently open tick (if any) and return it. */
  async closeTick(competitionId: string): Promise<CompetitionTick> {
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    if (!open) {
      throw new BadRequestException('No open tick for this competition');
    }
    open.phase = 'closed';
    open.windowEnd = new Date();
    return this.ticks.save(open);
  }

  /** Mark a competition completed (final tick closed). */
  async complete(competitionId: string): Promise<Competition> {
    const competition = await this.findOne(competitionId);
    competition.status = 'completed';
    return this.competitions.save(competition);
  }

  listTicks(competitionId: string): Promise<CompetitionTick[]> {
    return this.ticks.find({
      where: { competitionId },
      order: { tickIndex: 'ASC' },
    });
  }

  /** Return the currently open tick for a competition, if any. */
  async getOpenTick(competitionId: string): Promise<CompetitionTick | null> {
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    return open ?? null;
  }
}
