import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { StatsService } from './stats.service';
import { StatusService } from './status.service';
import { DocsService } from './docs.service';

/**
 * A supported parameter or a 400 — never a parameter that is quietly ignored.
 * Same rule as every other list endpoint here.
 */
export class RecentQueryDto {
  /**
   * Kept small on purpose. These are front-page feeds, not exports; the paged
   * per-agent endpoints are where a caller goes for history.
   */
  @IsOptional()
  @IsString()
  @IsIn(['5', '8', '10', '15', '20', '25', '50'])
  limit?: string;
}

/**
 * 🌐 Platform-wide reads. Public, like the rest of the read surface — what the
 * platform has done is the thing it asks to be judged on.
 */
@Controller('v1')
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly statusSvc: StatusService,
    private readonly docs: DocsService,
  ) {}

  /** Eight totals, each a count or a sum over a table. */
  @Get('stats')
  platform() {
    return this.stats.platform();
  }

  /** The most recent decisions across every agent. */
  @Get('decisions/recent')
  decisions(@Query() q: RecentQueryDto) {
    return this.stats.recentDecisions(Number(q.limit ?? 8));
  }

  /** The most recent settled trades across every agent. NOT decisions. */
  @Get('executions/recent')
  executions(@Query() q: RecentQueryDto) {
    return this.stats.recentExecutions(Number(q.limit ?? 8));
  }

  /**
   * 🌐 System status, from probes that measure something.
   *
   * Three states, not two: a probe that could not run reports `unknown`, and
   * `unknown` never resolves to green. A page reporting the absence of a check
   * as the success of one is the failure mode this whole surface exists against.
   */
  @Get('status')
  status() {
    return this.statusSvc.status();
  }

  /**
   * 🌐 Every figure the documentation quotes, read from the values in force.
   *
   * The docs prose is authored; its numbers are not. A page that hard-codes the
   * score weights is a copy of the engine written in English, and this
   * platform's weights already differ from the design document in both their
   * values and their shape — strategy is a multiplier here, not a term.
   */
  @Get('docs/parameters')
  docsParameters() {
    return this.docs.parameters();
  }
}
