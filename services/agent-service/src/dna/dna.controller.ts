import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { DnaService } from './dna.service';

/**
 * Agent DNA endpoints. §8 places these under the Agent Service, which is also
 * where the agent's identity and configuration live.
 */
@Controller()
export class DnaController {
  constructor(private readonly dna: DnaService) {}

  /** GET /v1/agents/:id/dna — fingerprint summary, risk personality, regimes. */
  @Get('v1/agents/:id/dna')
  get(@Param('id', ParseUuidAllPipe) id: string) {
    return this.dna.getDna(id);
  }

  /** GET /v1/agents/:id/dna/similar — nearest behavioural neighbours. */
  @Get('v1/agents/:id/dna/similar')
  similar(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number.parseInt(limit ?? '5', 10);
    return this.dna.similar(id, Number.isFinite(n) && n > 0 && n <= 50 ? n : 5);
  }

  /** Run one DNA batch cycle (driven by arcana-agent-dna.timer). */
  @Post('internal/v1/agents/dna/compute')
  compute() {
    return this.dna.computeAll();
  }
}
