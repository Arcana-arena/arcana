import { Controller, Get, Param } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { EvolutionService } from './evolution.service';

@Controller()
export class EvolutionController {
  constructor(private readonly evolution: EvolutionService) {}

  /**
   * GET /v1/agents/:id/evolution — the version chain this agent belongs to and
   * what changed between versions.
   *
   * Creating a version stays on POST /v1/agents/:id/evolve, which already
   * existed; this is the read side.
   */
  @Get('v1/agents/:id/evolution')
  get(@Param('id', ParseUuidAllPipe) id: string) {
    return this.evolution.getEvolution(id);
  }
}
