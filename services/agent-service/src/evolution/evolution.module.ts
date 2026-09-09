import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';

/** Read-model over the lineage in agents.parent_agent_id. No new tables. */
@Module({
  imports: [MarketModule],
  controllers: [EvolutionController],
  providers: [EvolutionService],
  exports: [EvolutionService],
})
export class EvolutionModule {}
