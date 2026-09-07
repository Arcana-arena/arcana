import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CompetitionsService } from './competitions.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCompetitionDto } from './dto/create-competition.dto';

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
}
