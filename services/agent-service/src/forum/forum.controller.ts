/**
 * The social layer's HTTP surface.
 *
 * 🌐 READING IS OPEN TO EVERYONE, without exception and without a session.
 * Boards, threads, replies, article comments and every count on them answer to
 * an anonymous caller — the same rule the leaderboard and the thesis record
 * follow, for the same reason: a discussion nobody can read without an account
 * is not a public record of anything.
 *
 * 🔒 WRITING NEEDS A SIGNED-IN WALLET **WITH A CREATOR PROFILE**. Every author
 * on this platform is a creator: agents, articles and theses all hang off
 * creators(id), and a forum keyed on the bare wallet would give one person a
 * handle in half the site and an 0x-prefix in the other half. A wallet without
 * a profile gets 403 creator_profile_required naming the form that makes one —
 * not a 500 from a NOT NULL constraint, which is what `creatorIdForWallet(...)!`
 * produced before OwnershipService.creatorIdOrRefuse existed.
 *
 * THE RATE LIMITS ARE PER WALLET AND DELIBERATELY UNEVEN. Starting threads is
 * the expensive act and is bounded hardest; reacting is cheap, reversible and
 * bounded loosest. They are the anti-spam floor, not the moderation system.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard, CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { parsePage } from '../common/pagination';
import { OwnershipService } from '../auth/ownership.service';
import { ForumService } from './forum.service';
import { ReactionsService } from './reactions.service';
import { ModerationService, type ModerationSubject } from './moderation.service';
import {
  CreatePostDto,
  CreateReportDto,
  CreateThreadDto,
  HideDto,
  UpdatePostDto,
  UpdateThreadDto,
} from './dto/forum.dto';
import type { ReactionKind } from './entities';

export class PageQueryDto {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() page_size?: string;
}

export class ReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['open', 'actioned', 'dismissed'])
  status?: string;
}

/**
 * The reaction kind lives in the path, so it is validated here rather than by a
 * DTO. Refused rather than defaulted: a caller that sent `lke` believes it
 * liked something, and quietly treating an unknown kind as 'like' would leave
 * them with a save they never made — or nothing, silently.
 */
const asKind = (raw: string): ReactionKind => {
  if (raw !== 'like' && raw !== 'save') {
    throw new BadRequestException({
      error: {
        code: 'invalid_reaction_kind',
        message: `kind must be 'like' or 'save'; got '${String(raw).slice(0, 20)}'.`,
      },
    });
  }
  return raw;
};

@Controller('v1/forum')
export class ForumController {
  constructor(
    private readonly forum: ForumService,
    private readonly reactions: ReactionsService,
    private readonly moderation: ModerationService,
    private readonly ownership: OwnershipService,
  ) {}

  /** 🌐 The boards and how much is in each. */
  @Get('boards')
  boards() {
    return this.forum.boards();
  }

  /** 🌐 A board's threads, most recently active first. */
  @Get('boards/:slug/threads')
  threads(@Param('slug') slug: string, @Query() q: PageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.forum.listThreads(slug, page, pageSize, offset);
  }

  /** 🔒 Start a thread. */
  @Post('threads')
  @RateLimit({ limit: 10, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async createThread(@Body() dto: CreateThreadDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    await this.ownership.assertMayPublish(creatorId);
    return this.forum.createThread(creatorId, dto);
  }

  /** 🌐 One thread. Hidden ones answer with the reason and no body. */
  @Get('threads/:id')
  thread(@Param('id', ParseUuidAllPipe) id: string) {
    return this.forum.findThread(id);
  }

  /** 🔒 Edit your own thread. */
  @Patch('threads/:id')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async editThread(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateThreadDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.forum.updateThread(creatorId, id, dto);
  }

  /** 🌐 The replies, oldest first — the order they were written in. */
  @Get('threads/:id/posts')
  posts(@Param('id', ParseUuidAllPipe) id: string, @Query() q: PageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.forum.listPosts({ thread_id: id }, page, pageSize, offset);
  }

  /** 🔒 Reply. */
  @Post('threads/:id/posts')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async reply(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: CreatePostDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    await this.ownership.assertMayPublish(creatorId);
    return this.forum.replyToThread(creatorId, id, dto);
  }

  /** 🔒 Like or save a thread. */
  @Post('threads/:id/reactions/:kind')
  @RateLimit({ limit: 300, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async react(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('kind') kind: string,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.reactions.add(creatorId, asKind(kind), { thread_id: id });
  }

  @Delete('threads/:id/reactions/:kind')
  @RateLimit({ limit: 300, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async unreact(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('kind') kind: string,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.reactions.remove(creatorId, asKind(kind), { thread_id: id });
  }

  /** 🔒 Report a thread. */
  @Post('threads/:id/reports')
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async reportThread(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: CreateReportDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.report(creatorId, { kind: 'thread', id }, dto);
  }

  /** 🔒 Hide / unhide a thread — operator, or the thread's own author. */
  @Post('threads/:id/hide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async hideThread(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: HideDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.hide({ creatorId, wallet }, { kind: 'thread', id }, dto.reason);
  }

  @Post('threads/:id/unhide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async unhideThread(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.unhide({ creatorId, wallet }, { kind: 'thread', id });
  }

  // ---------------------------------------------------------- posts by id

  /** 🔒 Edit your own reply or comment. */
  @Patch('posts/:id')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async editPost(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdatePostDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.forum.updatePost(creatorId, id, dto);
  }

  @Post('posts/:id/reports')
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async reportPost(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: CreateReportDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.report(creatorId, { kind: 'post', id }, dto);
  }

  @Post('posts/:id/hide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async hidePost(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: HideDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.hide({ creatorId, wallet }, { kind: 'post', id }, dto.reason);
  }

  @Post('posts/:id/unhide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async unhidePost(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.unhide({ creatorId, wallet }, { kind: 'post', id });
  }
}

/**
 * The social half of an article. The article itself — create, edit, read — stays
 * in ThesesModule where it was born; putting its comments there too would have
 * meant a second comment implementation, which is the one thing this module
 * exists to avoid.
 */
@Controller('v1/articles')
export class ArticleSocialController {
  constructor(
    private readonly forum: ForumService,
    private readonly reactions: ReactionsService,
    private readonly moderation: ModerationService,
    private readonly ownership: OwnershipService,
  ) {}

  /** 🌐 Comments under an article, oldest first. Same table as forum replies. */
  @Get(':id/comments')
  comments(@Param('id', ParseUuidAllPipe) id: string, @Query() q: PageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.forum.listPosts({ article_id: id }, page, pageSize, offset);
  }

  /** 🔒 Comment. */
  @Post(':id/comments')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async comment(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: CreatePostDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    await this.ownership.assertMayPublish(creatorId);
    return this.forum.commentOnArticle(creatorId, id, dto);
  }

  @Post(':id/reactions/:kind')
  @RateLimit({ limit: 300, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async react(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('kind') kind: string,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.reactions.add(creatorId, asKind(kind), { article_id: id });
  }

  @Delete(':id/reactions/:kind')
  @RateLimit({ limit: 300, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async unreact(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('kind') kind: string,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.reactions.remove(creatorId, asKind(kind), { article_id: id });
  }

  @Post(':id/reports')
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async report(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: CreateReportDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.report(creatorId, { kind: 'article', id }, dto);
  }

  @Post(':id/hide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async hide(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: HideDto,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.hide({ creatorId, wallet }, { kind: 'article', id }, dto.reason);
  }

  @Post(':id/unhide')
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async unhide(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    return this.moderation.unhide({ creatorId, wallet }, { kind: 'article', id });
  }
}

/**
 * What the signed-in viewer has done — asked for in one batch per page.
 *
 * WHY THIS IS A SEPARATE CALL AND NOT A FIELD ON THE PUBLIC READS. The board
 * and thread reads are identical for everybody, which is what lets them be
 * cached and read with no session at all. Folding "have I liked this" into them
 * would make every public read personal. So the page fetches the list
 * anonymously and, only when somebody is signed in, asks this endpoint which of
 * those ids they have reacted to.
 */
@Controller('v1/me')
export class MeSocialController {
  constructor(
    private readonly reactions: ReactionsService,
    private readonly forum: ForumService,
    private readonly ownership: OwnershipService,
  ) {}

  @Get('reactions')
  @UseGuards(JwtAuthGuard)
  async mine(
    @Query('threads') threads: string | undefined,
    @Query('articles') articles: string | undefined,
    @CurrentWallet() wallet: string,
  ) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    const ids = (raw?: string) =>
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    return this.reactions.mine(creatorId, ids(threads), ids(articles));
  }

  @Get('saved')
  @UseGuards(JwtAuthGuard)
  async saved(@Query() q: PageQueryDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.reactions.saved(creatorId, page, pageSize, offset);
  }

  @Get('threads')
  @UseGuards(JwtAuthGuard)
  async threads(@Query() q: PageQueryDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdOrRefuse(wallet);
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.forum.listThreadsForCreator(creatorId, page, pageSize, offset);
  }
}

/**
 * 👑 The report queue.
 *
 * Operator-only, because a report names who made it. Publishing that would make
 * reporting an act with a cost, which is the same as not having reports.
 */
@Controller('v1/moderation')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('reports')
  reports(@Query() q: ReportsQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.moderation.listReports(q.status, page, pageSize, offset);
  }
}

/** 🌐 A creator's threads — the forum half of a public profile. */
@Controller('v1/creators')
export class CreatorForumController {
  constructor(private readonly forum: ForumService) {}

  @Get(':id/threads')
  threads(@Param('id', ParseUuidAllPipe) id: string, @Query() q: PageQueryDto) {
    const { page, pageSize, offset } = parsePage(q.page, q.page_size);
    return this.forum.listThreadsForCreator(id, page, pageSize, offset);
  }
}
