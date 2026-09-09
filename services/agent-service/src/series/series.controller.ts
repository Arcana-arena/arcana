import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { SeriesService } from './series.service';
import { DecisionsQueryDto, SeriesQueryDto } from './dto/series-query.dto';

/**
 * The three series a track record is actually made of.
 *
 * All 🌐 public, like every other read surface: a record anyone can inspect is
 * the product, and putting the evidence behind a login would defeat the point
 * of collecting it.
 *
 * The Passport still embeds a short score preview (and `?history=full` for the
 * whole thing) because it is a single-call summary. These endpoints are what a
 * chart should use: paginated, bounded, downsampled on request, and season-
 * segmented so a line is never drawn across two different markets.
 */
@Controller()
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  /** GET /v1/agents/:id/series/score — ARCANA Score over time. */
  @Get('v1/agents/:id/series/score')
  score(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query() q: SeriesQueryDto,
  ) {
    return this.series.scoreSeries(id, q);
  }

  /** GET /v1/agents/:id/series/nav — portfolio NAV / equity curve. */
  @Get('v1/agents/:id/series/nav')
  nav(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query() q: SeriesQueryDto,
  ) {
    return this.series.navSeries(id, q);
  }

  /** GET /v1/agents/:id/decisions — the Verified Decision History (§5). */
  @Get('v1/agents/:id/decisions')
  decisions(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query() q: DecisionsQueryDto,
  ) {
    return this.series.decisions(id, q);
  }
}
