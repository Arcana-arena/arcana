import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentWallet, InternalKeyGuard, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { IsOptional, IsString } from 'class-validator';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { parsePage } from '../common/pagination';
import { OwnershipService } from '../auth/ownership.service';
import { ThesesService } from './theses.service';
import { ThesisResolutionService } from './resolution.service';
import { CreateThesisDto } from './dto/create-thesis.dto';
import { CreateArticleDto, UpdateArticleDto } from './dto/create-article.dto';

/**
 * Paging for the two thesis lists.
 *
 * `limit` used to be a fixed whitelist, which bounded one response and nothing
 * else: a creator with four hundred claims still returned all four hundred from
 * the creator list, which had no bound at all.
 */
export class ThesesPageQueryDto {
  // Strings, because parsePage takes the raw query values and owns both the
  // bounds and the refusal message. A second set of rules here would disagree
  // with it the first time either changed.
  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  page_size?: string;
}

/**
 * PROVE THIS THESIS — the public record of what creators claimed beforehand.
 *
 * Reading is open to everyone, because a prediction nobody can check is not a
 * prediction. Publishing needs a signed-in wallet that owns the agent named.
 */
@Controller('v1/theses')
export class ThesesController {
  constructor(
    private readonly theses: ThesesService,
    private readonly ownership: OwnershipService,
  ) {}

  /**
   * 🔒 Publish a claim.
   *
   * There is no edit and no delete. That is the feature, not an omission: a
   * forecast that can be revised after the market answers is a description of
   * the past wearing the clothes of a prediction.
   */
  @Post()
  @RateLimit({ limit: 10, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateThesisDto, @CurrentWallet() wallet: string) {
    const agentOwner = await this.ownership.assertOwnsAgent(wallet, dto.linked_agent_id);
    const creatorId = await this.ownership.creatorIdForWallet(wallet);
    return this.theses.create(creatorId ?? agentOwner, agentOwner, dto);
  }

  /** 🌐 Recently published claims, still running or already answered. */
  @Get('recent')
  recent(@Query() q: ThesesPageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.theses.listRecent(page, pageSize, offset);
  }

  /** 🌐 One thesis and, once resolved, the arithmetic behind its verdict. */
  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.theses.findOne(id);
  }
}

/** 🌐 A creator's record — every thesis, not only the ones that worked. */
@Controller('v1/creators')
export class CreatorThesesController {
  constructor(private readonly theses: ThesesService) {}

  @Get(':id/theses')
  list(@Param('id', ParseUuidAllPipe) id: string, @Query() q: ThesesPageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.theses.listForCreator(id, page, pageSize, offset);
  }

  @Get(':id/articles')
  articles(@Param('id', ParseUuidAllPipe) id: string) {
    return this.theses.listArticles(id);
  }
}

/** Creator writing, with or without a claim attached. */
@Controller('v1/articles')
export class ArticlesController {
  constructor(
    private readonly theses: ThesesService,
    private readonly ownership: OwnershipService,
  ) {}

  /** 🌐 Recent articles across the platform, newest first. */
  @Get()
  recent(@Query() q: ThesesPageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.theses.listRecentArticles(page, pageSize, offset);
  }

  /**
   * 🔒 Publish an article.
   *
   * AN AGENT NAMED HERE MUST BE THE AUTHOR'S OWN. The card under the article
   * publishes that agent's score, return, drawdown and open positions; letting
   * anyone bind any agent would turn a stranger's record into decoration for
   * somebody else's writing. This is the same rule a thesis follows.
   */
  @Post()
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateArticleDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    await this.ownership.assertMayPublish(creatorId);
    if (dto.agent_id) await this.ownership.assertOwnsAgent(wallet, dto.agent_id);
    return this.theses.createArticle(creatorId, dto);
  }

  /**
   * 🔒 Edit the prose. The thesis binding is not editable and is not accepted
   * here — the database refuses it too, because one of the two being enough is
   * how "cannot be changed" quietly becomes "cannot be changed through the UI".
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateArticleDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    if (dto.agent_id) await this.ownership.assertOwnsAgent(wallet, dto.agent_id);
    return this.theses.updateArticle(creatorId, id, dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.theses.findArticle(id);
  }
}

/**
 * 🌐 The writing that names one agent.
 *
 * A SEPARATE CONTROLLER ON THE SAME PREFIX, rather than a method on
 * AgentsController, and the reason is the import graph: AgentsModule has no
 * business depending on the article store, and an agent read that could reach
 * articles is one refactor away from an agent read that is reached BY them.
 * The agent is never told what was written about it.
 */
@Controller('v1/agents')
export class AgentArticlesController {
  constructor(private readonly theses: ThesesService) {}

  @Get(':id/articles')
  list(@Param('id', ParseUuidAllPipe) id: string, @Query() q: ThesesPageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.theses.listArticlesForAgent(id, page, pageSize, offset);
  }
}

/**
 * The resolution job's only door.
 *
 * BEHIND THE INTERNAL KEY, like the scoring batch and the competition tick. A
 * resolution that any caller could trigger would let someone run it early —
 * the measurement window is fixed, but a thesis resolved before its data
 * finished arriving is resolved on less of it, and the row can only be written
 * once.
 */
@Controller('internal/v1/theses')
@UseGuards(InternalKeyGuard)
export class InternalThesesController {
  constructor(private readonly resolution: ThesisResolutionService) {}

  @Post('resolve')
  resolve() {
    return this.resolution.resolveDue();
  }
}
