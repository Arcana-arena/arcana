/**
 * The social layer's tables, as TypeScript sees them.
 *
 * KEPT IN ONE FILE because they are one unit: a post is meaningless without the
 * thread it hangs from, a reaction without the thing it counts on. Five files
 * of eight lines each would hide that.
 *
 * THE QUERIES ARE RAW SQL, not repositories — the same choice ThesesService
 * makes, and for the same reason: every read here is a join with counts and a
 * handle, which a repository expresses worse than the SQL does. These classes
 * exist so the schema has a checked shape in TypeScript and so TypeORM's
 * autoLoadEntities knows the tables are ours.
 *
 * NOTHING HERE IS READ BY THE DECISION ENGINE. There is no column pointing at
 * an agent, a mandate or a score, and the one binding that names an agent at
 * all (articles.agent_id) is read by the web to display, never by anything that
 * decides. See 0056 and infra/verify/forum-verify.mjs.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('forum_boards')
export class ForumBoard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The stable half. URLs and the verification suite use this, not the name. */
  @Column({ type: 'varchar', length: 40, unique: true })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int' })
  position: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('forum_threads')
export class ForumThread {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id', type: 'uuid' })
  boardId: string;

  /**
   * The author, as a creator profile rather than a wallet.
   *
   * Everything else a person publishes here — agents, articles, theses — hangs
   * off creators(id). A forum keyed on the wallet would give the same person a
   * handle on one half of the site and an 0x-prefix on the other.
   */
  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /** Trigger-maintained (0056). Never written by this service. */
  @Column({ name: 'reply_count', type: 'int' })
  replyCount: number;

  @Column({ name: 'last_reply_at', type: 'timestamptz', nullable: true })
  lastReplyAt: Date | null;

  @Column({ name: 'like_count', type: 'int' })
  likeCount: number;

  @Column({ name: 'save_count', type: 'int' })
  saveCount: number;

  /** Hidden, not deleted. The row stays so the conversation still reads. */
  @Column({ name: 'hidden_at', type: 'timestamptz', nullable: true })
  hiddenAt: Date | null;

  @Column({ name: 'hidden_by', type: 'uuid', nullable: true })
  hiddenBy: string | null;

  @Column({ name: 'hidden_reason', type: 'text', nullable: true })
  hiddenReason: string | null;
}

/**
 * A reply under a thread, or a comment under an article. Exactly one.
 *
 * ONE TABLE, ONE MODERATION PATH. The brief asked for comments under articles
 * and replies in the forum; they are the same act, so a second table would have
 * bought two report shapes and two hide paths that drift apart.
 */
@Entity('forum_posts')
export class ForumPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'thread_id', type: 'uuid', nullable: true })
  threadId: string | null;

  @Column({ name: 'article_id', type: 'uuid', nullable: true })
  articleId: string | null;

  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'hidden_at', type: 'timestamptz', nullable: true })
  hiddenAt: Date | null;

  @Column({ name: 'hidden_by', type: 'uuid', nullable: true })
  hiddenBy: string | null;

  @Column({ name: 'hidden_reason', type: 'text', nullable: true })
  hiddenReason: string | null;
}

export type ReactionKind = 'like' | 'save';

@Entity('content_reactions')
export class ContentReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  @Column({ type: 'varchar', length: 8 })
  kind: ReactionKind;

  @Column({ name: 'thread_id', type: 'uuid', nullable: true })
  threadId: string | null;

  @Column({ name: 'article_id', type: 'uuid', nullable: true })
  articleId: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export type ReportReason = 'spam' | 'hate' | 'harassment' | 'scam' | 'off_topic' | 'other';

@Entity('content_reports')
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'reporter_id', type: 'uuid' })
  reporterId: string;

  @Column({ name: 'thread_id', type: 'uuid', nullable: true })
  threadId: string | null;

  @Column({ name: 'post_id', type: 'uuid', nullable: true })
  postId: string | null;

  @Column({ name: 'article_id', type: 'uuid', nullable: true })
  articleId: string | null;

  @Column({ type: 'varchar', length: 20 })
  reason: ReportReason;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'varchar', length: 12 })
  status: 'open' | 'actioned' | 'dismissed';

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;
}
