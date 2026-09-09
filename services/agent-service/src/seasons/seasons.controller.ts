import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard, JwtAuthGuard } from '@arcana/auth';
import { SeasonsService } from './seasons.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateSeasonDto } from './dto/create-season.dto';
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
  constructor(private readonly seasons: SeasonsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() dto: CreateSeasonDto) {
    return this.seasons.create(dto);
  }

  @Get()
  findAll() {
    return this.seasons.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.seasons.findOne(id);
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
