import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Competition } from './competition.entity';
import { CompetitionTick } from './competition-tick.entity';
import { CreateCompetitionDto } from './dto/create-competition.dto';

@Injectable()
export class CompetitionsService {
  constructor(
    @InjectRepository(Competition)
    private readonly competitions: Repository<Competition>,
    @InjectRepository(CompetitionTick)
    private readonly ticks: Repository<CompetitionTick>,
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

  /** Open the next decision round for a competition. */
  async openTick(
    competitionId: string,
    marketSnapshotRef: string,
  ): Promise<CompetitionTick> {
    const competition = await this.findOne(competitionId);
    if (competition.status === 'completed') {
      throw new BadRequestException('Competition is completed');
    }

    // Find an already-open tick (do not double-open).
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    if (open) {
      throw new BadRequestException(
        `Tick ${open.tickIndex} is already open for this competition`,
      );
    }

    const max = await this.ticks
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.tickIndex), -1)', 'max')
      .where('t.competitionId = :cid', { cid: competitionId })
      .getRawOne<{ max: string }>();

    const tick = this.ticks.create({
      competitionId,
      tickIndex: Number(max?.max ?? -1) + 1,
      phase: 'open',
      marketSnapshotRef,
      windowStart: new Date(),
    });
    const saved = await this.ticks.save(tick);

    if (competition.status === 'pending') {
      competition.status = 'running';
      await this.competitions.save(competition);
    }
    return saved;
  }

  /** Close the currently open tick (if any) and return it. */
  async closeTick(competitionId: string): Promise<CompetitionTick> {
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    if (!open) {
      throw new BadRequestException('No open tick for this competition');
    }
    open.phase = 'closed';
    open.windowEnd = new Date();
    return this.ticks.save(open);
  }

  /** Mark a competition completed (final tick closed). */
  async complete(competitionId: string): Promise<Competition> {
    const competition = await this.findOne(competitionId);
    competition.status = 'completed';
    return this.competitions.save(competition);
  }

  listTicks(competitionId: string): Promise<CompetitionTick[]> {
    return this.ticks.find({
      where: { competitionId },
      order: { tickIndex: 'ASC' },
    });
  }

  /** Return the currently open tick for a competition, if any. */
  async getOpenTick(competitionId: string): Promise<CompetitionTick | null> {
    const open = await this.ticks.findOne({
      where: { competitionId, phase: 'open' },
    });
    return open ?? null;
  }
}
