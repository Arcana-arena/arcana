import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArcanaAuthModule } from '@arcana/auth';
import { SeriesModule } from './series/series.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { StatsModule } from './stats/stats.module';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { CompetitionsModule } from './competitions/competitions.module';
import { CreatorsModule } from './creators/creators.module';
import { SeasonsModule } from './seasons/seasons.module';
import { DnaModule } from './dna/dna.module';
import { PassportModule } from './passport/passport.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { EvolutionModule } from './evolution/evolution.module';
import { AutopsyModule } from './autopsy/autopsy.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { ThesesModule } from './theses/theses.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ArcanaAuthModule.forRoot('agent-service'),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false, // schema is managed by golang-migrate, never sync
      }),
    }),
    AuthModule,
    AgentsModule,
    SeriesModule,
    LeaderboardModule,
    StatsModule,
    CreatorsModule,
    SeasonsModule,
    CompetitionsModule,
    DnaModule,
    PassportModule,
    SubscriptionsModule,
    EvolutionModule,
    AutopsyModule,
    // @Global does not mean "loaded without being imported": a global module
    // still has to be imported ONCE, here. Its import statement alone left the
    // service crash-looping on deploy with "can't resolve IntelligenceService"
    // — a failure no typecheck sees, because Nest resolves providers at boot.
    IntelligenceModule,
    ThesesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
