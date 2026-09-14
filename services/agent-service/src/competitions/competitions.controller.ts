import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { AdminGuard, CurrentWallet, InternalKeyGuard, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { CompetitionsService } from './competitions.service';
import { OwnershipService } from '../auth/ownership.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCompetitionDto } from './dto/create-competition.dto';
import { CompetitionsListQueryDto } from '../common/list-query.dto';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class OpenTickDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  marketSnapshotRef: string;

  /**
   * The interval the cadence enforces, recorded on the tick so the status page
   * can tell when the next one is due from the record (0050). Optional: a tick
   * opened by anything that does not run on an interval leaves it unrecorded.
   */
  @IsOptional()
  @IsInt()
  @Min(60)
  cadenceIntervalSeconds?: number;
}

export class JoinCompetitionDto {
  /** The agent to enter. It must be yours, and it must be active. */
  @IsUUID()
  agentId: string;
}

/**
 * Public reads and operator writes.
 *
 * Tick advancement is NOT here — it moved to InternalCompetitionsController
 * below. See that class for why.
 */
@Controller('v1/competitions')
export class CompetitionsController {
  constructor(
    private readonly competitions: CompetitionsService,
    private readonly ownership: OwnershipService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() dto: CreateCompetitionDto) {
    return this.competitions.create(dto);
  }

  /**
   * 🔑 Enter YOUR agent into a competition.
   *
   * Until this existed, entering one meant an operator writing to
   * `participant_ids` by hand: the controller had create and complete and
   * nothing else, so the only supported way in was a competition being created
   * with you already listed. That cannot be the flow an owner uses.
   *
   * OWNERSHIP FIRST, then the gates. assertOwnsAgent throws before any
   * entitlement call is made, so a caller cannot use this endpoint to probe
   * whether somebody else's agent would pass a gate.
   *
   * The $ARCA gates are not re-implemented here — the service runs the same
   * admit() loop that create() runs.
   */
  @Post(':id/participants')
  // Keyed by wallet, like agent creation: there is a proven identity to count
  // against, and entering is a deliberate act rather than a read.
  @RateLimit({ limit: 20, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async join(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: JoinCompetitionDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, dto.agentId);
    return this.competitions.joinParticipant(id, dto.agentId);
  }

  /**
   * 🔑 Withdraw YOUR agent from a competition, without retiring it.
   *
   * Separate from retire() on purpose. Retiring hands back the seat too, but it
   * also stands the agent down everywhere — so before this endpoint existed,
   * "stop competing in this arena" and "stop being an agent" were the same
   * action, and an owner who wanted the first had to accept the second.
   *
   * Allowed at any point, including mid-competition: leaving ends only this
   * agent's own record, while ENTERING late changes what the standings mean for
   * everyone already in.
   */
  @Delete(':id/participants/:agentId')
  @UseGuards(JwtAuthGuard)
  async leave(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('agentId', ParseUuidAllPipe) agentId: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, agentId);
    return this.competitions.leaveParticipant(id, agentId);
  }

  @Post(':id/complete')
  @UseGuards(JwtAuthGuard, AdminGuard)
  complete(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.complete(id);
  }

  // --- 🌐 public: a competition's state is part of the public record --------

  /**
   * Competitions, paged and filterable.
   *
   * `seasonId` used to short-circuit to an unpaged `findBySeason`, so the one
   * filter a caller was most likely to use was also the one that bypassed the
   * page ceiling. It is now a filter like any other — same response shape,
   * same limit — because a bound that a query parameter can step around is not
   * a bound.
   */
  @Get()
  findAll(@Query() query: CompetitionsListQueryDto) {
    const { page: p, pageSize: ps, offset } = parsePage(
      query.page, query.page_size);
    return this.competitions.findAllPaged({
      page: p, pageSize: ps, offset,
      // season_id, not seasonId. See CompetitionsListQueryDto: the old spelling
      // matched nothing and returned every competition with a 200.
      seasonId: query.season_id?.trim() || undefined,
      status: query.status?.trim() || undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.findOne(id);
  }

  /**
   * 🌐 Standings for one competition — who is in it and who is ahead.
   *
   * Public, like every other read of the track record. Ranked by NAV rather
   * than by ARCANA Score: see CompetitionsService.standings() for why those
   * are different questions and why using the score here would let an agent
   * lead a contest it is losing.
   */
  @Get(':id/standings')
  standings(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.standings(id);
  }

  @Get(':id/ticks')
  listTicks(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.listTicks(id);
  }

  @Get(':id/tick/open')
  async getOpenTick(@Param('id', ParseUuidAllPipe) id: string) {
    const tick = await this.competitions.getOpenTick(id);
    return { tick: tick ?? null };
  }
}

/**
 * ⚙️ Machine tier — the scheduler advancing a competition.
 *
 * These two moved off `/v1/` for a reason worth stating: opening and closing a
 * tick is the platform running the competition, not a user acting on it. They
 * sat on the public prefix with no guard, so anyone who could reach the port
 * could open an extra tick or close a live one mid-window.
 *
 * No user session can reach them now, and no user session should: a competition
 * that only advances when someone is logged in would not be an automated
 * competition. The scheduler presents X-Internal-Key and runs unattended,
 * exactly as before.
 */
@Controller('internal/v1/competitions')
@UseGuards(InternalKeyGuard)
export class InternalCompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post(':id/ticks')
  openTick(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: OpenTickDto,
  ) {
    return this.competitions.openTick(id, dto.marketSnapshotRef, dto.cadenceIntervalSeconds ?? null);
  }

  @Post(':id/ticks/close')
  closeTick(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.closeTick(id);
  }
}
