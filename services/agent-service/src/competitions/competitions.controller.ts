import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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

  @Get()
  findAll(@Query('seasonId') seasonId?: string) {
    if (seasonId) {
      return this.competitions.findBySeason(seasonId);
    }
    return this.competitions.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.findOne(id);
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
