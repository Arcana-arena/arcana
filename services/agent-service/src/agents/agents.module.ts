import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './agent.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { DecisionClient } from '../decisions/decision.client';

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), EntitlementsModule, AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, DecisionClient],
})
export class AgentsModule {}
