import { Module } from '@nestjs/common';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';
import { MarketPriceClient } from './market-price.client';

/**
 * No TypeOrmModule.forFeature here: every read is raw SQL. These endpoints
 * exist to bucket, aggregate and window time series, and an ORM round-trip
 * would hide the part that matters — the GROUP BY that keeps a bucket inside
 * one season, and the min/max that keeps a drawdown visible.
 */
@Module({
  controllers: [SeriesController],
  providers: [SeriesService, MarketPriceClient],
  exports: [SeriesService],
})
export class SeriesModule {}
