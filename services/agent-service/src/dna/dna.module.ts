import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { DnaController } from './dna.controller';
import { DnaService } from './dna.service';

/**
 * No TypeOrmModule.forFeature here: agent_dna is read and written through raw
 * SQL because its fingerprint column is a pgvector type TypeORM does not model,
 * and the similarity query is expressed with pgvector's `<=>` operator.
 */
@Module({
  imports: [MarketModule],
  controllers: [DnaController],
  providers: [DnaService],
})
export class DnaModule {}
