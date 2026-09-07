import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from './agent.entity';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
  ) {}

  async create(dto: CreateAgentDto): Promise<Agent> {
    const latest = await this.agents.findOne({
      where: { creatorId: dto.creatorId, name: dto.name },
      order: { version: 'DESC' },
    });
    const version = latest ? latest.version + 1 : 1;

    const agent = this.agents.create({
      creatorId: dto.creatorId,
      name: dto.name,
      version,
      parentAgentId: dto.parentAgentId ?? null,
      strategyType: dto.strategyType ?? null,
      riskProfile: dto.riskProfile ? JSON.parse(dto.riskProfile) : {},
      assetUniverse: dto.assetUniverse,
      status: dto.status ?? 'draft',
    });
    return this.agents.save(agent);
  }

  findAll(): Promise<Agent[]> {
    return this.agents.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id } });
    if (!agent) {
      throw new NotFoundException(`Agent ${id} not found`);
    }
    return agent;
  }

  async update(id: string, dto: UpdateAgentDto): Promise<Agent> {
    const agent = await this.findOne(id);
    Object.assign(agent, dto);
    return this.agents.save(agent);
  }

  /** POST /agents/:id/activate — check $ARCA CREATE entitlement + transition to active. */
  async activate(id: string): Promise<Agent> {
    const agent = await this.findOne(id);
    if (agent.status === 'retired') {
      throw new BadRequestException('Retired agents cannot be activated');
    }
    agent.status = 'active';
    return this.agents.save(agent);
  }

  /** POST /agents/:id/evolve — create a new version snapshotting this agent's config. */
  async evolve(id: string, overrides: EvolveAgentDto): Promise<Agent> {
    const agent = await this.findOne(id);
    const child = await this.create({
      creatorId: agent.creatorId,
      name: agent.name,
      strategyType: overrides.strategyType ?? agent.strategyType ?? undefined,
      riskProfile: overrides.riskProfile ?? JSON.stringify(agent.riskProfile),
      assetUniverse: overrides.assetUniverse ?? agent.assetUniverse,
      parentAgentId: agent.id,
      status: 'draft',
    });
    return child;
  }
}
