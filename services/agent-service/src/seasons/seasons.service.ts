import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Season } from './season.entity';
import { CreateSeasonDto } from './dto/create-season.dto';
import { UpdateSeasonDto } from './dto/update-season.dto';

@Injectable()
export class SeasonsService {
  constructor(
    @InjectRepository(Season)
    private readonly seasons: Repository<Season>,
  ) {}

  create(dto: CreateSeasonDto): Promise<Season> {
    const season = this.seasons.create({
      name: dto.name,
      universe: dto.universe,
      startAt: new Date(dto.startAt),
      endAt: new Date(dto.endAt),
      ruleset: JSON.parse(dto.ruleset),
    });
    return this.seasons.save(season);
  }

  findAll(): Promise<Season[]> {
    return this.seasons.find({ order: { startAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Season> {
    const season = await this.seasons.findOne({ where: { id } });
    if (!season) {
      throw new NotFoundException(`Season ${id} not found`);
    }
    return season;
  }

  async update(id: string, dto: UpdateSeasonDto): Promise<Season> {
    const season = await this.findOne(id);
    if (dto.name !== undefined) season.name = dto.name;
    if (dto.startAt !== undefined) season.startAt = new Date(dto.startAt);
    if (dto.endAt !== undefined) season.endAt = new Date(dto.endAt);
    return this.seasons.save(season);
  }
}
