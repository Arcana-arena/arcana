import { Controller, Get, Query } from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { LeaderboardService } from './leaderboard.service';

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
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  list(
    @Query('season_id') seasonId?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('include_unranked') includeUnranked?: string,
  ) {
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
    });
  }
}
