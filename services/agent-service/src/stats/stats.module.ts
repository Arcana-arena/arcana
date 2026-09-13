import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatusService } from './status.service';
import { DocsService } from './docs.service';

@Module({
  controllers: [StatsController],
  providers: [StatsService, StatusService, DocsService],
})
export class StatsModule {}
