import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './agent.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), EntitlementsModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
