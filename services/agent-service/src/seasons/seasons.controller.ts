import { Body, Controller, Get, Param, Patch, Post, UseGuards, Query } from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { AdminGuard, JwtAuthGuard } from '@arcana/auth';
import { SeasonsService } from './seasons.service';
import { SeasonDetailService } from './season-detail.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateSeasonDto } from './dto/create-season.dto';
import { SeasonsListQueryDto } from '../common/list-query.dto';
import { UpdateSeasonDto } from './dto/update-season.dto';

/**
 * Seasons are read by everyone and written by operators.
 *
 * A season is platform structure, not user content — opening or archiving one
 * moves every competing agent at once. 👑 is enforced as a wallet allowlist
 * (AUTH_ADMIN_WALLETS) checked after SIWE, so an operator action is always
 * attributable to a wallet that proved itself.
 */
@Controller('v1/seasons')
export class SeasonsController {
  constructor(
    private readonly seasons: SeasonsService,
    private readonly detail: SeasonDetailService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() dto: CreateSeasonDto) {
    return this.seasons.create(dto);
  }

  @Get()
  findAll(@Query() query: SeasonsListQueryDto) {
    const { page: p, pageSize: ps, offset } = parsePage(
      query.page, query.page_size);
    return this.seasons.findAllPaged({ page: p, pageSize: ps, offset });
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.seasons.findOne(id);
  }

  /**
   * 🌐 Every rule this competition would be run under — including the ones
   * nothing enforces.
   *
   * A rules table that silently omits the rules the platform does not encode
   * reads as a complete rules table, and the first entrant who is not turned
   * away by a "minimum NAV" learns it was decoration. Each row therefore
   * carries `enforced`, and an unenforced rule carries no invented figure.
   */
  @Get(':id/rules')
  rules(@Param('id', ParseUuidAllPipe) id: string) {
    return this.detail.rules(id);
  }

  /**
   * 🌐 The ticks this season has actually produced.
   *
   * The one question standings cannot answer: has the competition been running,
   * or did it stop. Days with no tick are ABSENT from the daily array rather
   * than present with a count of zero.
   */
  @Get(':id/ticks')
  ticks(@Param('id', ParseUuidAllPipe) id: string) {
    return this.detail.ticks(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateSeasonDto,
  ) {
    return this.seasons.update(id, dto);
  }
}
