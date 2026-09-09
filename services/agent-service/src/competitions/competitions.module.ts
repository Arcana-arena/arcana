import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Competition } from './competition.entity';
import { CompetitionTick } from './competition-tick.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { SeasonsModule } from '../seasons/seasons.module';
import {
  CompetitionsController,
  InternalCompetitionsController,
} from './competitions.controller';
import { CompetitionsService } from './competitions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Competition, CompetitionTick]),
    EntitlementsModule,
    SeasonsModule,
  ],
  controllers: [CompetitionsController, InternalCompetitionsController],
  providers: [CompetitionsService],
})
export class CompetitionsModule {}
