import { Module } from '@nestjs/common';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardSeriesService } from './series';

/**
 * No TypeOrmModule.forFeature: the read is raw SQL, and deliberately so. The
 * ranking is a window function over one season's latest snapshot per agent —
 * an ORM round-trip would hide the two things that matter, that the rank spans
 * the whole filtered set rather than the page, and that unranked agents are
 * never interleaved with ranked ones.
 */
@Module({
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardSeriesService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
