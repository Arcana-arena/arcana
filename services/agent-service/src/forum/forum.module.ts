import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import {
  ContentReaction,
  ContentReport,
  ForumBoard,
  ForumPost,
  ForumThread,
} from './entities';
import {
  ArticleSocialController,
  CreatorForumController,
  ForumController,
  MeSocialController,
  ModerationController,
} from './forum.controller';
import { ForumService } from './forum.service';
import { ReactionsService } from './reactions.service';
import { ModerationService } from './moderation.service';

/**
 * THE SOCIAL LAYER.
 *
 * WHAT IT IMPORTS IS THE POINT. AuthModule, for OwnershipService — who is
 * signed in, do they have a creator profile, may they publish. And nothing
 * else: no AgentsModule, no LeaderboardModule, no MarketModule. A module that
 * cannot reach the agent services cannot accidentally grow a path from a forum
 * post into a decision, and the import list is where a reviewer can see that in
 * one glance.
 *
 * The one agent-shaped thing here — an article naming an agent — is an id on
 * the articles table, rendered by the web from the agent's own public endpoints.
 * It is not read by this module at all.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ForumBoard, ForumThread, ForumPost, ContentReaction, ContentReport]),
    AuthModule,
  ],
  controllers: [
    ForumController,
    ArticleSocialController,
    MeSocialController,
    ModerationController,
    CreatorForumController,
  ],
  providers: [ForumService, ReactionsService, ModerationService],
  exports: [ForumService, ReactionsService],
})
export class ForumModule {}
