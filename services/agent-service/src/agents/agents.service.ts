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
import { EntitlementClient } from '../entitlements/entitlement.client';

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    private readonly entitlements: EntitlementClient,
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

  /**
   * POST /agents/:id/activate — transition to active.
   *
   * Gated on the $ARCA CREATE entitlement (§2.7). The check is real, but note
   * what "allowed" means today: the token has not launched, so arca-service
   * passes every check WITHOUT reading a balance and says so in its response.
   * The gate is wired, not yet enforcing. See docs/arca-entitlements.md.
   *
   * Activating a version RETIRES its parent (see retireParent).
   */
  async activate(id: string): Promise<Agent> {
    const agent = await this.findOne(id);
    if (agent.status === 'retired') {
      throw new BadRequestException('Retired agents cannot be activated');
    }

    const wallet = await this.entitlements.walletForCreator(agent.creatorId);
    await this.entitlements.require('create', wallet, `activate agent ${agent.id}`);

    agent.status = 'active';
    const saved = await this.agents.save(agent);
    if (agent.parentAgentId) {
      await this.retireParent(agent.parentAgentId, agent.id);
    }
    return saved;
  }

  /**
   * Succession: when a version goes live, the version it replaces steps down.
   *
   * Why retire rather than let both compete: the leaderboard is the platform's
   * reputation surface, and a creator running v1..v5 side by side would occupy
   * five places with five variations of one idea. "V1 → V2 → V3" is a
   * succession, not a family.
   *
   * Nothing is erased. The parent's row, decisions, portfolio snapshots and
   * score history are append-only and untouched; it keeps its Passport and its
   * badges, and its record simply closes at this point. That closure is also
   * what makes the before/after comparison meaningful — "before" becomes a
   * finished period rather than a moving target.
   *
   * The cost, stated plainly: the two versions then never trade the same ticks,
   * so no comparison between them can fully separate the agent from its market.
   * See docs/agent-evolution.md.
   */
  private async retireParent(parentId: string, childId: string): Promise<void> {
    const parent = await this.agents.findOne({ where: { id: parentId } });
    if (!parent || parent.status === 'retired') return;

    parent.status = 'retired';
    await this.agents.save(parent);

    // Hand over the parent's seat in any competition still running. Without
    // this the scheduler keeps calling a retired agent every tick and logs a
    // failure every minute forever — the kind of permanent noise that teaches
    // people to stop reading the journal.
    await this.agents.manager.query(
      `UPDATE competitions
          SET participant_ids = array_replace(participant_ids, $1::uuid, $2::uuid)
        WHERE status <> 'completed'
          AND $1::uuid = ANY(participant_ids)
          AND NOT ($2::uuid = ANY(participant_ids))`,
      [parentId, childId],
    );
    // If the child was already a participant, just drop the parent's seat.
    await this.agents.manager.query(
      `UPDATE competitions
          SET participant_ids = array_remove(participant_ids, $1::uuid)
        WHERE status <> 'completed'
          AND $1::uuid = ANY(participant_ids)`,
      [parentId],
    );
  }

  /**
   * POST /agents/:id/evolve — create a new version snapshotting this agent's config.
   *
   * Gated on the $ARCA EVOLVE entitlement (§2.7). Checked here, at creation,
   * rather than at activation: evolving is the act the entitlement covers, and
   * a creator should learn they lack the right before building a version, not
   * after.
   */
  async evolve(id: string, overrides: EvolveAgentDto): Promise<Agent> {
    const agent = await this.findOne(id);

    const wallet = await this.entitlements.walletForCreator(agent.creatorId);
    await this.entitlements.require('evolve', wallet, `evolve agent ${agent.id}`);

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
