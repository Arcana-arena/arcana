import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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

@Controller('v1/competitions')
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post()
  create(@Body() dto: CreateCompetitionDto) {
    return this.competitions.create(dto);
  }

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

  @Post(':id/complete')
  complete(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.complete(id);
  }

  @Get(':id/ticks')
  listTicks(@Param('id', ParseUuidAllPipe) id: string) {
    return this.competitions.listTicks(id);
  }
}
