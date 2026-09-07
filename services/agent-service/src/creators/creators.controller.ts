import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CreatorsService } from './creators.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

@Controller('v1/creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  @Post()
  create(@Body() dto: CreateCreatorDto) {
    return this.creators.create(dto);
  }

  @Get()
  findAll() {
    return this.creators.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.creators.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateCreatorDto,
  ) {
    return this.creators.update(id, dto);
  }
}
