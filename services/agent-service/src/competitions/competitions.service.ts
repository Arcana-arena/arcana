import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Competition } from './competition.entity';
import { Page, pageOf } from '../common/pagination';
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

    const allVerified = await this.admit(dto.participantIds ?? [], season, premium);

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

  /**
   * Run every entry gate for a set of agents. Returns whether all of them were
   * admitted against a balance that was actually read.
   *
   * EXTRACTED SO THERE IS ONE COPY. This loop used to live inside create(), and
   * create() was the only way into a competition — an operator writing to the
   * database. The moment a second door exists, a gate that lives inside the
   * first one is a gate the second one does not have; joinParticipant() calls
   * this, and a future third door will have to as well or it will not compile.
   */
  private async admit(agentIds: string[], season: { name: string }, premium: boolean): Promise<boolean> {
    // Starts true and is falsified by any check that admitted without reading
    // a balance. "Every gate verified" is the claim that needs evidence; one
    // unverified pass is enough to withdraw it.
    let allVerified = true;
    for (const participantId of agentIds) {
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
    return allVerified;
  }

  /**
   * POST /competitions/:id/participants — an owner enters their own agent.
   *
   * WHY THIS EXISTS. Entering a competition was an operator writing to
   * `participant_ids` by hand. The controller had create and complete and
   * nothing else, so the only supported way in was a season being created with
   * you already in it. That cannot be the flow a real owner uses.
   *
   * THE GATES ARE THE SAME ONES. It calls admit(), which is the loop create()
   * uses: COMPETE always, PREMIUM_ARENA as well in a premium arena. A door that
   * reached the array without them would be a hole opened by convenience.
   *
   * ENTRY CLOSES AT THE FIRST TICK, and that is the fairness rule.
   *
   * Not at 'running' — at the first tick. A competition that has started but
   * has not yet opened a tick has no history for a newcomer to be missing, so
   * there is nothing unfair about joining it. Once one tick exists there is: the
   * standings read each participant's NAV series, and an agent that has traded
   * three hours would be ranked beside one that has traded three days as though
   * the two numbers meant the same thing. Nothing in the standings query can
   * express that difference, and the scoring formula is not ours to bend for it.
   *
   * So the refusal is explicit and names the remedy — the next competition of
   * the season — rather than admitting the agent into a comparison it cannot
   * win or lose honestly.
   */
  async joinParticipant(competitionId: string, agentId: string): Promise<CompetitionRegistration> {
    const competition = await this.findOne(competitionId);

    if (competition.status === 'completed') {
      throw new BadRequestException({
        code: 'competition_completed',
        message: 'This competition has finished. Enter the next one in the season.',
      });
    }

    const ticks = await this.ticks.count({ where: { competitionId } });
    if (ticks > 0) {
      throw new BadRequestException({
        code: 'competition_already_started',
        message:
          `This competition has already run ${ticks} tick(s). An agent entering now would be ` +
          'ranked against agents whose record covers a longer window, and the standings cannot ' +
          'say which is which. Enter the next competition of this season instead.',
        ticks_elapsed: ticks,
      });
    }

    if ((competition.participantIds ?? []).includes(agentId)) {
      throw new BadRequestException({
        code: 'already_a_participant',
        message: `Agent ${agentId} is already entered in this competition.`,
      });
    }

    const season = await this.seasons.findEntity(competition.seasonId);
    const premium = season.accessTier === 'premium';
    const allVerified = await this.admit([agentId], season, premium);

    // Appended in the database rather than in memory: two owners entering at the
    // same moment would otherwise each write the array they read, and the later
    // write would drop the earlier agent without any error being raised.
    await this.competitions.manager.query(
      `UPDATE competitions
          SET participant_ids = array_append(participant_ids, $2::uuid)
        WHERE id = $1::uuid
          AND NOT ($2::uuid = ANY(coalesce(participant_ids, '{}'::uuid[])))`,
      [competitionId, agentId],
    );

    const saved = await this.findOne(competitionId);
    return {
      ...saved,
      access: {
        tier: season.accessTier,
        gates_applied: premium ? ['compete', PREMIUM_ARENA_ACTION] : ['compete'],
        balance_checked: allVerified,
        note: allVerified
          ? 'Admitted against a verified $ARCA balance.'
          : 'Admitted, but a gate passed WITHOUT reading a balance (the token is not ' +
            'launched, or no threshold is set for that action). This is a pass by default, ' +
            'not a verified entitlement.',
      },
    };
  }

  /**
   * DELETE /competitions/:id/participants/:agentId — an owner stands down.
   *
   * ALLOWED AT ANY TIME, including mid-competition, and deliberately not
   * symmetric with entry. Entry is refused after the first tick because it
   * changes what the standings mean for everyone else; leaving only ends this
   * agent's own record. Withdrawing is not a privilege anyone should have to
   * hold tokens or wait for a boundary to exercise — the same reasoning retire()
   * already follows.
   *
   * It does NOT retire the agent. That distinction is the point of this door
   * existing: until now the only way out of a running competition was
   * retire(), so "stop competing here" and "stand this agent down entirely"
   * were the same action.
   */
  async leaveParticipant(competitionId: string, agentId: string): Promise<Competition> {
    const competition = await this.findOne(competitionId);
    if (!(competition.participantIds ?? []).includes(agentId)) {
      throw new BadRequestException({
        code: 'not_a_participant',
        message: `Agent ${agentId} is not entered in this competition.`,
      });
    }
    await this.competitions.manager.query(
      `UPDATE competitions SET participant_ids = array_remove(participant_ids, $2::uuid)
        WHERE id = $1::uuid`,
      [competitionId, agentId],
    );
    return this.findOne(competitionId);
  }

  async findAllPaged(opts: { page: number; pageSize: number; offset: number; seasonId?: string; status?: string }): Promise<Page<Competition>> {
    const qb = this.competitions.createQueryBuilder('c');
    if (opts.seasonId) qb.andWhere('c.season_id = :seasonId', { seasonId: opts.seasonId });
    if (opts.status) qb.andWhere('c.status = :status', { status: opts.status });
    const [items, total] = await qb
      .orderBy('c.id', 'DESC')
      .skip(opts.offset)
      .take(opts.pageSize)
      .getManyAndCount();
    return pageOf(items, total, opts.page, opts.pageSize);
  }

  /**
   * Standings for one competition: who is in it and how they are doing.
   *
   * WHY THIS DID NOT EXIST, AND WHY IT HAD TO. The leaderboard ranks agents
   * across a season by score. A competition is a smaller thing — a fixed set
   * of participants over a run of ticks — and the only way to see how one was
   * going was to fetch every participant separately and compare their
   * portfolios by hand. That is a join the client should never have been asked
   * to do, and the two ways of doing it would have disagreed the first time
   * anyone got it slightly wrong.
   *
   * RANKED BY NAV, NOT BY SCORE. Deliberate, and the distinction matters:
   *
   *   * the ARCANA Score measures an agent across everything it has ever done,
   *     with risk, consistency, longevity and creator factors folded in. It is
   *     a reputation, and it is season-scoped.
   *   * a competition standing answers "who is ahead in THIS contest, right
   *     now". That is what the money did, over these ticks, from a common
   *     starting point.
   *
   * Ranking a competition by ARCANA Score would let an agent lead a contest it
   * is losing, on the strength of history from outside it. Nothing here
   * touches the scoring formula or regime_score — this reads portfolios.
   *
   * Every participant appears, including ones with no portfolio yet, marked
   * rather than omitted. A participant silently missing from standings is
   * indistinguishable from one that was never registered.
   */
  async standings(id: string) {
    const competition = await this.findOne(id);

    const rows: Array<{
      agent_id: string;
      name: string | null;
      version: number | null;
      status: string | null;
      strategy_type: string | null;
      creator_handle: string | null;
      nav: string | null;
      cash: string | null;
      snapshot_at: Date | null;
      decisions: string;
    }> = await this.competitions.manager.query(
      // portfolio_snapshots is keyed by PORTFOLIO, not by agent — an agent has
      // one portfolio per season — so the join runs through `portfolios`.
      // Reading it as agent-keyed produced "column agent_id does not exist",
      // which is the schema being right and the query being written from
      // memory.
      //
      // Scoped to the competition's OWN season. Without that, an agent
      // competing in two seasons would have whichever portfolio snapshot was
      // most recent shown as its standing here — its Season 2 NAV appearing in
      // a Season 1 contest. The same mistake migration 0022 fixed for the
      // leaderboard.
      `WITH latest AS (
         SELECT DISTINCT ON (p.agent_id) p.agent_id, ps.nav, ps.cash, ps.ts
           FROM portfolios p
           JOIN portfolio_snapshots ps ON ps.portfolio_id = p.id
          WHERE p.agent_id = ANY($1::uuid[])
            AND p.season_id = $2::uuid
          ORDER BY p.agent_id, ps.ts DESC
       )
       SELECT a.id  AS agent_id,
              a.name,
              a.version,
              a.status,
              a.strategy_type,
              c.handle AS creator_handle,
              l.nav,
              l.cash,
              l.ts   AS snapshot_at,
              (SELECT count(*) FROM decisions_counted d
                WHERE d.agent_id = a.id AND d.season_id = $2::uuid) AS decisions
         FROM unnest($1::uuid[]) AS p(id)
         JOIN agents a   ON a.id = p.id
         LEFT JOIN creators c ON c.id = a.creator_id
         LEFT JOIN latest l   ON l.agent_id = a.id`,
      [competition.participantIds ?? [], competition.seasonId],
    );

    // Sorted here rather than in SQL because a NULL nav must sort LAST
    // regardless of direction, and "no portfolio yet" is not last place — it
    // is not a place at all. Postgres would need an explicit NULLS LAST that
    // is easy to lose in a later edit.
    const ranked = [...rows].sort((x, y) => {
      const nx = x.nav == null ? null : Number(x.nav);
      const ny = y.nav == null ? null : Number(y.nav);
      if (nx == null && ny == null) return 0;
      if (nx == null) return 1;
      if (ny == null) return -1;
      return ny - nx;
    });

    const ticks = await this.ticks.count({ where: { competitionId: id } });

    return {
      competition: {
        id: competition.id,
        season_id: competition.seasonId,
        type: competition.type,
        status: competition.status,
        ticks,
      },
      standings: ranked.map((r, i) => ({
        // Rank is null for a participant with no portfolio: it has not placed,
        // which is different from placing last.
        rank: r.nav == null ? null : i + 1,
        agent_id: r.agent_id,
        name: r.name,
        version: r.version,
        status: r.status,
        strategy_type: r.strategy_type,
        creator_handle: r.creator_handle,
        nav: r.nav,
        cash: r.cash,
        snapshot_at: r.snapshot_at,
        decisions: Number(r.decisions),
        note: r.nav == null
          ? 'No portfolio snapshot yet — this agent has not been valued in this competition.'
          : undefined,
      })),
      ranked_by: 'nav',
      note:
        'Ranked by NAV, not by ARCANA Score. The score is a season-wide reputation ' +
        'including risk, consistency and longevity; a standing answers who is ahead ' +
        'in this contest right now. Ranking a competition by score would let an agent ' +
        'lead a contest it is losing, on the strength of history from outside it.',
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
    cadenceIntervalSeconds: number | null = null,
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
      cadenceIntervalSeconds,
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
