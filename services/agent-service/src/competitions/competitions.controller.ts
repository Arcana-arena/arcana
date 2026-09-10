import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { AdminGuard, InternalKeyGuard, JwtAuthGuard } from '@arcana/auth';
import { CompetitionsService } from './competitions.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCompetitionDto } from './dto/create-competition.dto';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class OpenTickDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  marketSnapshotRef: string;
}

/**
 * Public reads and operator writes.
 *
 * Tick advancement is NOT here — it moved to InternalCompetitionsController
 * below. See that class for why.
 */
@Controller('v1/competitions')
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() dto: CreateCompetitionDto) {
    return this.competitions.create(dto);
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
  findAll(
    @Query('seasonId') seasonId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const { page: p, pageSize: ps, offset } = parsePage(page, pageSize);
    return this.competitions.findAllPaged({
      page: p, pageSize: ps, offset,
      seasonId: seasonId?.trim() || undefined,
      status: status?.trim() || undefined,
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
    return this.competitions.openTick(id, dto.marketSnapshotRef);
  }

  @Post(':id/ticks/close')
  closeTick(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.closeTick(id);
  }
}
