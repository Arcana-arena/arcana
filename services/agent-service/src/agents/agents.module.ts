import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './agent.entity';
import { AgentWallet } from './agent-wallet.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { MarketPriceClient } from '../series/market-price.client';
import { AgentOverviewService } from './overview.service';
import { AgentPositionsService } from './positions.service';
import { AgentWalletsService } from './agent-wallets.service';
import { DecisionClient } from '../decisions/decision.client';
import { AgentLifecycleService } from './lifecycle.service';
import { AgentTriggersService } from './triggers.service';
import { AgentWalletViewService } from './wallet-view.service';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentWallet]), EntitlementsModule, AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentWalletsService, DecisionClient, AgentOverviewService, AgentPositionsService, MarketPriceClient, AgentLifecycleService, AgentTriggersService, AgentWalletViewService],
  exports: [AgentWalletsService],
})
export class AgentsModule {}
