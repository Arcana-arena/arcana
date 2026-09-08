import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { AgentsModule } from './agents/agents.module';
import { CompetitionsModule } from './competitions/competitions.module';
import { CreatorsModule } from './creators/creators.module';
import { SeasonsModule } from './seasons/seasons.module';
import { DnaModule } from './dna/dna.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false, // schema is managed by golang-migrate, never sync
      }),
    }),
    AgentsModule,
    CreatorsModule,
    SeasonsModule,
    CompetitionsModule,
    DnaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
