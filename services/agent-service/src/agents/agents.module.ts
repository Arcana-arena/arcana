import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './agent.entity';
import { AgentWallet } from './agent-wallet.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentWalletsService } from './agent-wallets.service';
import { DecisionClient } from '../decisions/decision.client';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentWallet]), EntitlementsModule, AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentWalletsService, DecisionClient],
  exports: [AgentWalletsService],
})
export class AgentsModule {}
