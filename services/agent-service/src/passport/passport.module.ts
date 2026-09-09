import { Module } from '@nestjs/common';
import { PassportController } from './passport.controller';
import { PassportService } from './passport.service';

/**
 * No entities registered: the passport is a read-model assembled with raw SQL
 * across agents, portfolios, portfolio_snapshots, score_snapshots, agent_dna
 * and creators. There is no passport table, by design.
 */
@Module({
  controllers: [PassportController],
  providers: [PassportService],
})
export class PassportModule {}
