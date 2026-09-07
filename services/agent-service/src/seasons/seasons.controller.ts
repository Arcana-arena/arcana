import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SeasonsService } from './seasons.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateSeasonDto } from './dto/create-season.dto';
import { UpdateSeasonDto } from './dto/update-season.dto';

@Controller('v1/seasons')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Post()
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
  update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateSeasonDto,
  ) {
    return this.seasons.update(id, dto);
  }
}
