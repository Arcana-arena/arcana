import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './agent.entity';
import { AgentWallet } from './agent-wallet.entity';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { AgentsController, InternalAgentPacingController } from './agents.controller';
import { AgentsService } from './agents.service';
import { MarketPriceClient } from '../series/market-price.client';
import { AgentOverviewService } from './overview.service';
import { AgentPositionsService } from './positions.service';
import { AgentCapitalService } from './capital.service';
import { AgentWalletsService } from './agent-wallets.service';
import { DecisionClient } from '../decisions/decision.client';
import { AgentLifecycleService } from './lifecycle.service';
import { AgentTriggersService } from './triggers.service';
import { AgentWalletViewService } from './wallet-view.service';
import { AgentPacingService } from './pacing.service';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentWallet]), EntitlementsModule, AuthModule],
  controllers: [AgentsController, InternalAgentPacingController],
  providers: [AgentsService, AgentWalletsService, DecisionClient, AgentOverviewService, AgentPositionsService, AgentCapitalService, MarketPriceClient, AgentLifecycleService, AgentTriggersService, AgentWalletViewService, AgentPacingService],
  // AgentWalletViewService is exported so the creator dashboard reads gas with
  // the wallet tab's own measurement instead of a second definition of "low".
  // AgentPositionsService is exported so the creator portfolio reads positions
  // through the same code as the public Positions tab.
  exports: [AgentWalletsService, AgentWalletViewService, AgentPositionsService],
})
export class AgentsModule {}
