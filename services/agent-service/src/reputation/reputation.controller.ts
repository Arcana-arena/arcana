import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { ReputationService } from './reputation.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 🌐 Reputation that can be computed again — public, unauthenticated, for every
 * agent. A score, its inputs and its formula are public for private agents too:
 * they are built from decisions, snapshots and scores that are already public.
 */
@Controller()
export class ReputationController {
  constructor(private readonly reputation: ReputationService) {}

  /** 🌐 A sealed score: its manifest, a recomputation, every input checked, and its anchor. */
  @Get('v1/agents/:id/score/verification')
  scoreVerification(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query('season_id') seasonId?: string,
    @Query('ts') ts?: string,
  ) {
    if (seasonId !== undefined && !UUID.test(seasonId)) {
      throw new BadRequestException({ code: 'invalid_season_id', message: 'season_id must be a UUID.' });
    }
    if (ts !== undefined && Number.isNaN(Date.parse(ts))) {
      throw new BadRequestException({ code: 'invalid_ts', message: 'ts must be an ISO-8601 timestamp.' });
    }
    return this.reputation.scoreVerification(id, seasonId, ts);
  }

  /** 🌐 The formula of one version: its steps and constants. */
  @Get('v1/score-formulas/:version')
  formula(@Param('version') version: string) {
    return this.reputation.formula(version);
  }

  /** 🌐 A creator's reputation, derived from sealed scores, with every input. */
  @Get('v1/creators/:id/reputation')
  creatorReputation(@Param('id', ParseUuidAllPipe) id: string) {
    return this.reputation.creatorReputation(id);
  }
}
