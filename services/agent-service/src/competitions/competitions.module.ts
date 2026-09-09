import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Competition } from './competition.entity';
import { CompetitionTick } from './competition-tick.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { CompetitionsController } from './competitions.controller';
import { CompetitionsService } from './competitions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Competition, CompetitionTick]),
    EntitlementsModule,
  ],
  controllers: [CompetitionsController],
  providers: [CompetitionsService],
})
export class CompetitionsModule {}
