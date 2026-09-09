import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { PassportService } from './passport.service';

@Controller()
export class PassportController {
  constructor(private readonly passport: PassportService) {}

  /**
   * GET /v1/agents/:id/passport — the agent's career record.
   *
   * The score series is trimmed to a recent window by default so the passport
   * stays light enough to embed in a listing; ?history=full returns all of it.
   * That keeps one endpoint rather than splitting into full and summary
   * variants that would drift apart.
   */
  @Get('v1/agents/:id/passport')
  get(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query('history') history?: string,
  ) {
    return this.passport.getPassport(id, history === 'full');
  }
}
