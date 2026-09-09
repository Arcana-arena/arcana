import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard } from '@arcana/auth';
import { randomUUID } from 'node:crypto';
import { AgentsService } from './agents.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { ManualDecisionDto } from './dto/manual-decision.dto';
import { OwnershipService } from '../auth/ownership.service';
import { DecisionClient } from '../decisions/decision.client';

/**
 * Reads are public; writes require a session, and writes to a specific agent
 * require owning it.
 *
 * The public half is not an oversight — a track record anyone can inspect is
 * the product. Leaderboard, profile, passport, DNA, evolution and autopsy stay
 * open, and they keep working even when auth is misconfigured.
 */
@Controller('v1/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly ownership: OwnershipService,
    private readonly decisions: DecisionClient,
  ) {}

  // --- 🔑 login required ----------------------------------------------------

  /**
   * The owner is the caller. A wallet with no creator profile yet is told to
   * make one rather than having one conjured for it — creating a creator is a
   * deliberate act with a handle the user chooses.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateAgentDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdForWallet(wallet);
    if (!creatorId) {
      throw new ForbiddenException({
        error: {
          code: 'no_creator_profile',
          message:
            'This wallet has no creator profile yet. Create one with ' +
            'POST /v1/creators before creating agents.',
          trace_id: randomUUID(),
        },
      });
    }
    return this.agents.create(dto, creatorId);
  }

  // --- 🌐 public reads ------------------------------------------------------

  @Get()
  findAll() {
    return this.agents.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.agents.findOne(id);
  }

  // --- 🔒 login + ownership -------------------------------------------------
  //
  // Ownership is asserted first, then the service applies whatever $ARCA
  // entitlement the action carries. Two questions, asked in that order, with
  // two different failures: 403 forbidden_not_owner vs 403 entitlement_denied_*.

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.update(id, dto);
  }

  @Post(':id/activate')
  @UseGuards(JwtAuthGuard)
  async activate(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.activate(id);
  }

  @Post(':id/evolve')
  @UseGuards(JwtAuthGuard)
  async evolve(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: EvolveAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.evolve(id, dto);
  }

  @Post(':id/retire')
  @UseGuards(JwtAuthGuard)
  async retire(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.retire(id);
  }

  /**
   * A human submits a trade for their own agent in a human_vs_ai competition.
   *
   * This replaces `POST /internal/v1/decisions/manual` as the user-facing door.
   * The engine still exposes that internal endpoint for machines; what changed
   * is that a person no longer reaches it directly, and cannot submit for an
   * agent that is not theirs.
   */
  @Post(':id/decisions')
  @UseGuards(JwtAuthGuard)
  async submitDecision(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: ManualDecisionDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.decisions.submitManual({
      agent_id: id,
      season_id: dto.season_id,
      market_snapshot_ref: dto.market_snapshot_ref,
      timestamp: new Date().toISOString(),
      trade: {
        symbol: dto.trade.symbol ?? '',
        action: dto.trade.action,
        quantity: dto.trade.quantity ?? 0,
      },
    });
  }
}
