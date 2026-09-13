import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { parsePage } from '../common/pagination';
import { CurrentWallet, JwtAuthGuard } from '@arcana/auth';
import { CreatorsService } from './creators.service';
import { CreatorDashboardService } from './dashboard.service';
import { CreatorEarningsService } from './earnings.client';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';
import { OwnershipService } from '../auth/ownership.service';
import { AgentListQueryDto } from '../series/dto/series-query.dto';
import { VERIFICATION_HEADER, provenanceFrom } from '../common/verification';

@Controller('v1/creators')
export class CreatorsController {
  constructor(
    private readonly creators: CreatorsService,
    private readonly ownership: OwnershipService,
    private readonly dashboardSvc: CreatorDashboardService,
    private readonly earningsSvc: CreatorEarningsService,
  ) {}

  /** 🔑 Register the calling wallet's creator profile. */
  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @Body() dto: CreateCreatorDto,
    @CurrentWallet() wallet: string,
    @Headers(VERIFICATION_HEADER) verification?: string,
  ) {
    return this.creators.create(dto, wallet, provenanceFrom(verification));
  }

  /** 🌐 Creator profiles are public — they are part of the track record. */
  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('q') q?: string,
  ) {
    const { page: p, pageSize: ps, offset } = parsePage(page, pageSize);
    return this.creators.findAllPaged({ page: p, pageSize: ps, offset, q: q?.trim() || undefined });
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.creators.findOne(id);
  }

  /**
   * 🌐 GET /v1/creators/:id/agents — this creator's agents, paginated.
   *
   * Public like the rest of the read surface: whose agent is whose is part of
   * the record. It is the creator dashboard's list, but it is not private.
   */
  @Get(':id/agents')
  listAgents(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query() q: AgentListQueryDto,
  ) {
    return this.creators.listAgents(id, q);
  }

  /**
   * 🔒 A creator's own dashboard: their agents, their slots, and what is wrong.
   *
   * PRIVATE, unlike the agent list above it. That one is a public record; this
   * one carries wallet addresses, the state of protective levels, and the
   * reason each agent is or is not working — which together are a map of
   * somebody's money.
   *
   * It answers the two questions an owner opens a dashboard with, and neither
   * is in a list of agents: is anything wrong, and how many slots are left.
   */
  @Get(':id/dashboard')
  @UseGuards(JwtAuthGuard)
  async dashboard(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsCreator(wallet, id);
    return this.dashboardSvc.forCreator(id);
  }

  /**
   * 🔒 What this creator has been paid, and by whom.
   *
   * Proxied from arca-service, which owns `payment_claims` and wrote every row
   * in it from a verified transfer. A second sum here would be a second
   * definition of "what this creator has earned"; the ownership check is here
   * because arca-service does not hold the session.
   */
  @Get(':id/earnings')
  @UseGuards(JwtAuthGuard)
  async earnings(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsCreator(wallet, id);
    return this.earningsSvc.forCreator(id);
  }

  /** 🔒 Yourself only. */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateCreatorDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsCreator(wallet, id);
    return this.creators.update(id, dto);
  }
}
