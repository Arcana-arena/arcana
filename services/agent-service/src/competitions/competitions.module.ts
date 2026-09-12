import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Competition } from './competition.entity';
import { CompetitionTick } from './competition-tick.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { SeasonsModule } from '../seasons/seasons.module';
import { AuthModule } from '../auth/auth.module';
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
    // For OwnershipService: the join and leave doors check that the caller owns
    // the agent before any entitlement call is made.
    AuthModule,
  ],
  controllers: [CompetitionsController, InternalCompetitionsController],
  providers: [CompetitionsService],
})
export class CompetitionsModule {}
