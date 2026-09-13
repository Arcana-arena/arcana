import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { parsePage } from '../common/pagination';
import { AnchorsService } from './anchors.service';

function positiveInt(raw: string, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException({ code: `invalid_${what}`, message: `${what} must be a positive integer. Got '${raw.slice(0, 20)}'.` });
  }
  return n;
}

/**
 * 🌐 Anchors — public, unauthenticated, for every agent. An anchor holds only
 * commitments, which are public for private agents too.
 */
@Controller()
export class AnchorsController {
  constructor(private readonly anchors: AnchorsService) {}

  /** 🌐 Every root written on chain, newest first, and what anchoring has cost the platform. */
  @Get('v1/anchors')
  list(@Query('page') page?: string, @Query('page_size') pageSize?: string) {
    const p = parsePage(page, pageSize);
    return this.anchors.list(p.page, p.pageSize, p.offset);
  }

  /** 🌐 One anchor: its leaves, its transaction, and whether they agree. */
  @Get('v1/anchors/:id')
  detail(@Param('id') id: string) {
    return this.anchors.detail(positiveInt(id, 'anchor_id'));
  }

  /** 🌐 Which root contains this decision, with the proof and every check. */
  @Get('v1/agents/:id/decisions/:decisionId/anchor')
  forDecision(@Param('id', ParseUuidAllPipe) id: string, @Param('decisionId') decisionId: string) {
    return this.anchors.forDecision(id, positiveInt(decisionId, 'decision_id'));
  }
}
