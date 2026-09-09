import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { AutopsyController } from './autopsy.controller';
import { AutopsyService } from './autopsy.service';

/**
 * Read-model. No tables, no batch, no timer: the analysis is derived per
 * request from rows that already exist, and the market index it needs is
 * already cached by MarketIndexService.
 */
@Module({
  imports: [MarketModule],
  controllers: [AutopsyController],
  providers: [AutopsyService],
})
export class AutopsyModule {}
