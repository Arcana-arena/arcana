import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Creator } from './creator.entity';
import { AuthModule } from '../auth/auth.module';
import { AgentsModule } from '../agents/agents.module';
import { CreatorsController } from './creators.controller';
import { CreatorsService } from './creators.service';
import { CreatorDashboardService } from './dashboard.service';
import { CreatorEarningsService } from './earnings.client';

@Module({
  imports: [TypeOrmModule.forFeature([Creator]), AuthModule, AgentsModule],
  controllers: [CreatorsController],
  providers: [CreatorsService, CreatorDashboardService, CreatorEarningsService],
})
export class CreatorsModule {}
