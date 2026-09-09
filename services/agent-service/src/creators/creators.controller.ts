import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard } from '@arcana/auth';
import { CreatorsService } from './creators.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';
import { OwnershipService } from '../auth/ownership.service';

@Controller('v1/creators')
export class CreatorsController {
  constructor(
    private readonly creators: CreatorsService,
    private readonly ownership: OwnershipService,
  ) {}

  /** 🔑 Register the calling wallet's creator profile. */
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateCreatorDto, @CurrentWallet() wallet: string) {
    return this.creators.create(dto, wallet);
  }

  /** 🌐 Creator profiles are public — they are part of the track record. */
  @Get()
  findAll() {
    return this.creators.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.creators.findOne(id);
  }

  /** 🔒 Yourself only. */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateCreatorDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsCreator(wallet, id);
    return this.creators.update(id, dto);
  }
}
