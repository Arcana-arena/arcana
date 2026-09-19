import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicThesis } from './thesis.entity';
import { Article } from './article.entity';
import { MarketModule } from '../market/market.module';
import { AuthModule } from '../auth/auth.module';
import {
  ArticlesController,
  CreatorThesesController,
  InternalThesesController,
  ThesesController,
} from './theses.controller';
import { ThesesService } from './theses.service';
import { ThesisResolutionService } from './resolution.service';

/**
 * PROVE THIS THESIS.
 *
 * MarketModule, not a second price reader. The benchmark leg and the ARCANA
 * index both come from MarketIndexService, which owns the one definition of
 * what the market did on a tick — a module that derived its own would agree
 * with it on every day it still agreed.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PublicThesis, Article]), MarketModule, AuthModule],
  controllers: [
    ThesesController,
    CreatorThesesController,
    ArticlesController,
    InternalThesesController,
  ],
  providers: [ThesesService, ThesisResolutionService],
  exports: [ThesesService],
})
export class ThesesModule {}
