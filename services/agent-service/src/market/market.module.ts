import { Module } from '@nestjs/common';
import { MarketIndexService } from './market-index.service';

/** Shared market index, used by Agent DNA and Agent Evolution. */
@Module({
  providers: [MarketIndexService],
  exports: [MarketIndexService],
})
export class MarketModule {}
