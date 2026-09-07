import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Competition } from './competition.entity';
import { CreateCompetitionDto } from './dto/create-competition.dto';

@Injectable()
export class CompetitionsService {
  constructor(
    @InjectRepository(Competition)
    private readonly competitions: Repository<Competition>,
  ) {}

  create(dto: CreateCompetitionDto): Promise<Competition> {
    const competition = this.competitions.create({
      seasonId: dto.seasonId,
      type: dto.type,
      participantIds: dto.participantIds,
      status: 'pending',
    });
    return this.competitions.save(competition);
  }

  findAll(): Promise<Competition[]> {
    return this.competitions.find({ order: { id: 'DESC' } });
  }

  async findOne(id: string): Promise<Competition> {
    const competition = await this.competitions.findOne({ where: { id } });
    if (!competition) {
      throw new NotFoundException(`Competition ${id} not found`);
    }
    return competition;
  }

  async findBySeason(seasonId: string): Promise<Competition[]> {
    return this.competitions.find({ where: { seasonId } });
  }
}
