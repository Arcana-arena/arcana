import { Controller, Get, Query } from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardSeriesService } from './series';
import { LeaderboardQueryDto } from '../common/list-query.dto';

/**
 * Public, like every other read of the track record.
 *
 * A leaderboard behind a session would be a leaderboard nobody can link to,
 * and the public record is the product. It is paginated for the same reason
 * the other lists are: one unauthenticated request must not be able to
 * serialise an unbounded table.
 */
@Controller('v1/leaderboard')
export class LeaderboardController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly series: LeaderboardSeriesService,
  ) {}

  @Get()
  list(@Query() query: LeaderboardQueryDto) {
    const seasonId = query.season_id;
    const category = query.category;
    const page = query.page;
    const pageSize = query.page_size;
    const includeUnranked = query.include_unranked;
    const { page: p, pageSize: ps, offset } = parsePage(page, pageSize);
    return this.leaderboard.list({
      seasonId: seasonId || undefined,
      category: category || 'overall',
      page: p,
      pageSize: ps,
      offset,
      // ONLY THE WORD "true" TURNS IT ON. `include_unranked=0` and
      // `include_unranked=false` both mean off, and a truthiness check on the
      // string would read both as on — which would put unranked agents on the
      // default board for every caller who tried to switch them off.
      includeUnranked: includeUnranked === 'true' || includeUnranked === '1',
      q: query.q?.trim() || undefined,
      universe: query.universe?.trim() || undefined,
      status: query.status?.trim() || undefined,
      // Number(undefined) is NaN and Number('') is 0 — both would become a
      // filter nobody asked for, so the string is checked before it is parsed.
      minScore: query.min_score ? Number(query.min_score) : undefined,
      maxScore: query.max_score ? Number(query.max_score) : undefined,
    });
  }

  /**
   * Return, drawdown, age and a sparkline for every agent in the season.
   *
   * A SECOND READ RATHER THAN FOUR MORE COLUMNS. These come from the NAV series
   * — a per-agent scan of portfolio_snapshots — and the leaderboard itself is a
   * cheap one-row-per-agent read that several surfaces use without needing any
   * of this. The page asks for both in parallel and joins them by agent_id.
   */
  @Get('series')
  seriesForSeason(@Query() query: LeaderboardQueryDto) {
    return this.leaderboard
      .resolveSeasonId(query.season_id || undefined)
      .then((id) => this.series.forSeason(id, Number(query.buckets ?? 12)));
  }
}
