import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from './agent.entity';
import { DueAgent, dueAgents } from './cadence';

/**
 * Whose clock has come round.
 *
 * Thin on purpose: the query is in `cadence.ts` next to the bounds it enforces,
 * so the rule and the number it rests on are read together. This exists so the
 * pacer has one door and the repository has one connection.
 */
@Injectable()
export class AgentPacingService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
  ) {}

  due(now = new Date()): Promise<DueAgent[]> {
    return dueAgents(this.agents.manager, now);
  }
}
