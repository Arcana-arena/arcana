/**
 * Boards, threads, and the one kind of post that serves both a thread reply and
 * an article comment.
 *
 * WHAT THIS SERVICE MAY NOT DO, stated once here because it is the whole point
 * of the feature: it reads and writes conversation. It does not read an agent's
 * mandate, does not write to decisions, score_snapshots or anything a scoring
 * run consults, and holds no reference the decision engine could follow. The
 * social layer reads the platform; the platform does not read it back.
 *
 * NO NUMBER ON A THREAD IS COMPUTED HERE. reply_count, last_reply_at,
 * like_count and save_count are maintained by the triggers in 0056, recomputed
 * from the rows they count. A service that incremented them would be a second
 * opinion about the same fact, and the two would disagree the first time a
 * write path forgot one.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { forbidden } from '@arcana/auth';
import { pageOf } from '../common/pagination';
import { CreatePostDto, CreateThreadDto, UpdatePostDto, UpdateThreadDto } from './dto/forum.dto';

/** What a hidden row exposes. Never the body, always the reason. */
type HiddenNote = { at: Date; reason: string } | null;

const hiddenNote = (at: Date | null, reason: string | null): HiddenNote =>
  at ? { at, reason: reason ?? 'no reason recorded' } : null;

@Injectable()
export class ForumService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ------------------------------------------------------------------ boards

  /**
   * 🌐 The boards, with how much is in each.
   *
   * The counts exclude hidden threads, because a board index is a place to
   * discover things and a removed thread is not one. A permalink to that same
   * thread still answers — see findThread — since somebody holding the link
   * deserves to be told what happened rather than handed a 404.
   */
  async boards() {
    const rows = await this.db.query(
      `SELECT b.id, b.slug, b.name, b.description, b.position,
              (SELECT count(*) FROM forum_threads t
                WHERE t.board_id = b.id AND t.hidden_at IS NULL) AS thread_count,
              (SELECT max(coalesce(t.last_reply_at, t.created_at)) FROM forum_threads t
                WHERE t.board_id = b.id AND t.hidden_at IS NULL) AS last_activity_at
         FROM forum_boards b
        ORDER BY b.position`,
    );
    return {
      items: rows.map((b: Record<string, unknown>) => ({
        slug: b.slug,
        name: b.name,
        description: b.description,
        thread_count: Number(b.thread_count),
        last_activity_at: b.last_activity_at ?? null,
      })),
    };
  }

  private async boardBySlug(slug: string) {
    const rows = await this.db.query(
      `SELECT id, slug, name, description FROM forum_boards WHERE slug = $1`,
      [slug],
    );
    if (rows.length === 0) {
      throw new NotFoundException({
        error: {
          code: 'board_not_found',
          message: `There is no board called '${slug}'. Read GET /v1/forum/boards for the list.`,
        },
      });
    }
    return rows[0];
  }

  // ----------------------------------------------------------------- threads

  /**
   * 🌐 A board's threads, most recently active first.
   *
   * ORDERED BY LAST ACTIVITY, NOT BY CREATION, with coalesce so a thread nobody
   * has answered sorts by when it was written. The database decides the order
   * and the page renders it as given; a client that re-sorted would still show
   * every thread, in a sequence that is nobody's.
   */
  async listThreads(slug: string, page: number, pageSize: number, offset: number) {
    const board = await this.boardBySlug(slug);

    const rows = await this.db.query(
      `SELECT t.id, t.title, t.created_at, t.updated_at, t.reply_count, t.last_reply_at,
              t.like_count, t.save_count,
              c.id AS creator_id, c.handle AS creator_handle
         FROM forum_threads t
         JOIN creators c ON c.id = t.creator_id
        WHERE t.board_id = $1 AND t.hidden_at IS NULL
        ORDER BY coalesce(t.last_reply_at, t.created_at) DESC, t.id
        LIMIT $2 OFFSET $3`,
      [board.id, pageSize, offset],
    );
    const total = Number(
      (
        await this.db.query(
          `SELECT count(*) AS n FROM forum_threads WHERE board_id = $1 AND hidden_at IS NULL`,
          [board.id],
        )
      )[0].n,
    );

    return {
      board: { slug: board.slug, name: board.name, description: board.description },
      ...pageOf(rows.map((r: Record<string, unknown>) => this.threadSummary(r)), total, page, pageSize),
    };
  }

  private threadSummary(r: Record<string, any>) {
    return {
      id: r.id,
      title: r.title,
      author: { id: r.creator_id, handle: r.creator_handle },
      created_at: r.created_at,
      updated_at: r.updated_at,
      reply_count: Number(r.reply_count),
      last_reply_at: r.last_reply_at ?? null,
      like_count: Number(r.like_count),
      save_count: Number(r.save_count),
    };
  }

  /**
   * 🌐 One thread.
   *
   * A hidden thread ANSWERS 200 with its body withheld, rather than 404. The
   * two are different facts — "this was removed, here is why" and "this never
   * existed" — and a reader following a link from somewhere else is owed the
   * first one when it is true.
   */
  async findThread(id: string) {
    const rows = await this.db.query(
      `SELECT t.*, c.handle AS creator_handle, b.slug AS board_slug, b.name AS board_name
         FROM forum_threads t
         JOIN creators c ON c.id = t.creator_id
         JOIN forum_boards b ON b.id = t.board_id
        WHERE t.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`Thread ${id} not found`);
    const t = rows[0];
    const hidden = hiddenNote(t.hidden_at, t.hidden_reason);

    return {
      id: t.id,
      board: { slug: t.board_slug, name: t.board_name },
      title: hidden ? null : t.title,
      body: hidden ? null : t.body,
      author: { id: t.creator_id, handle: t.creator_handle },
      created_at: t.created_at,
      updated_at: t.updated_at,
      reply_count: Number(t.reply_count),
      last_reply_at: t.last_reply_at ?? null,
      like_count: Number(t.like_count),
      save_count: Number(t.save_count),
      hidden,
    };
  }

  async createThread(creatorId: string, dto: CreateThreadDto) {
    const board = await this.boardBySlug(dto.board);
    const rows = await this.db.query(
      `INSERT INTO forum_threads (board_id, creator_id, title, body)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [board.id, creatorId, dto.title.trim(), dto.body],
    );
    return { id: rows[0].id, board: board.slug, created_at: rows[0].created_at };
  }

  /** 🔒 The author may edit their own prose. Hidden content is not editable. */
  async updateThread(creatorId: string, id: string, dto: UpdateThreadDto) {
    const rows = await this.db.query(
      `SELECT creator_id, hidden_at FROM forum_threads WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`Thread ${id} not found`);
    if (rows[0].creator_id !== creatorId) {
      throw forbidden('forbidden_not_owner', 'Only the author can edit this thread.');
    }
    if (rows[0].hidden_at) {
      throw forbidden(
        'content_hidden',
        'This thread has been hidden by moderation and cannot be edited. Editing it would ' +
          'change what a moderator acted on while the record still says they acted.',
      );
    }
    await this.db.query(
      `UPDATE forum_threads SET title = coalesce($2, title), body = coalesce($3, body)
        WHERE id = $1`,
      [id, dto.title?.trim() ?? null, dto.body ?? null],
    );
    return this.findThread(id);
  }

  // ------------------------------------------------------------------- posts

  /**
   * 🌐 The replies under a thread, or the comments under an article.
   *
   * IN THE ORDER THEY WERE WRITTEN, oldest first, with `id` as the tiebreak so
   * two posts sharing a millisecond cannot swap places between two reads of the
   * same page. A conversation read in any other order is a different
   * conversation.
   *
   * HIDDEN POSTS STAY IN PLACE, as a marker with no body. Removing them from
   * the sequence would leave the replies that answered them looking like
   * non-sequiturs, and would quietly make moderation invisible.
   */
  async listPosts(
    subject: { thread_id: string } | { article_id: string },
    page: number,
    pageSize: number,
    offset: number,
  ) {
    const isThread = 'thread_id' in subject;
    const column = isThread ? 'thread_id' : 'article_id';
    const id = isThread ? subject.thread_id : subject.article_id;
    await this.assertSubjectExists(isThread, id);

    const rows = await this.db.query(
      `SELECT p.id, p.body, p.created_at, p.updated_at, p.hidden_at, p.hidden_reason,
              c.id AS creator_id, c.handle AS creator_handle
         FROM forum_posts p
         JOIN creators c ON c.id = p.creator_id
        WHERE p.${column} = $1
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT $2 OFFSET $3`,
      [id, pageSize, offset],
    );
    const total = Number(
      (await this.db.query(
        `SELECT count(*) AS n FROM forum_posts WHERE ${column} = $1`, [id]))[0].n,
    );

    const items = rows.map((r: Record<string, any>) => {
      const hidden = hiddenNote(r.hidden_at, r.hidden_reason);
      return {
        id: r.id,
        author: { id: r.creator_id, handle: r.creator_handle },
        // WITHHELD, not blanked. `null` is a value a page must decide how to
        // render; an empty string renders as a post with nothing in it, which
        // is a different claim about what happened.
        body: hidden ? null : r.body,
        created_at: r.created_at,
        updated_at: r.updated_at,
        hidden,
      };
    });
    return { subject: isThread ? { thread_id: id } : { article_id: id }, ...pageOf(items, total, page, pageSize) };
  }

  private async assertSubjectExists(isThread: boolean, id: string) {
    const table = isThread ? 'forum_threads' : 'articles';
    const rows = await this.db.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
    if (rows.length === 0) {
      throw new NotFoundException(`${isThread ? 'Thread' : 'Article'} ${id} not found`);
    }
  }

  /**
   * 🔒 Reply to a thread.
   *
   * A hidden thread takes no replies. The thread is still readable, so the
   * refusal is specific rather than a 404: answering something a moderator
   * removed would restart the conversation underneath the removal.
   */
  async replyToThread(creatorId: string, threadId: string, dto: CreatePostDto) {
    const rows = await this.db.query(
      `SELECT hidden_at FROM forum_threads WHERE id = $1`, [threadId]);
    if (rows.length === 0) throw new NotFoundException(`Thread ${threadId} not found`);
    if (rows[0].hidden_at) {
      throw forbidden('content_hidden', 'This thread was hidden by moderation and is closed to replies.');
    }
    return this.insertPost(creatorId, { thread_id: threadId }, dto);
  }

  /** 🔒 Comment under an article — the same table, the same moderation path. */
  async commentOnArticle(creatorId: string, articleId: string, dto: CreatePostDto) {
    await this.assertSubjectExists(false, articleId);
    return this.insertPost(creatorId, { article_id: articleId }, dto);
  }

  private async insertPost(
    creatorId: string,
    subject: { thread_id: string } | { article_id: string },
    dto: CreatePostDto,
  ) {
    const threadId = 'thread_id' in subject ? subject.thread_id : null;
    const articleId = 'article_id' in subject ? subject.article_id : null;
    const rows = await this.db.query(
      `INSERT INTO forum_posts (thread_id, article_id, creator_id, body)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [threadId, articleId, creatorId, dto.body],
    );
    return { id: rows[0].id, created_at: rows[0].created_at, ...subject };
  }

  /** 🔒 The author may edit their own post, unless moderation has hidden it. */
  async updatePost(creatorId: string, id: string, dto: UpdatePostDto) {
    const rows = await this.db.query(
      `SELECT creator_id, hidden_at, thread_id, article_id FROM forum_posts WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`Post ${id} not found`);
    if (rows[0].creator_id !== creatorId) {
      throw forbidden('forbidden_not_owner', 'Only the author can edit this post.');
    }
    if (rows[0].hidden_at) {
      throw forbidden('content_hidden', 'This post has been hidden by moderation and cannot be edited.');
    }
    await this.db.query(`UPDATE forum_posts SET body = $2 WHERE id = $1`, [id, dto.body]);
    const after = await this.db.query(
      `SELECT id, body, created_at, updated_at FROM forum_posts WHERE id = $1`, [id]);
    return after[0];
  }

  /** 🌐 A creator's threads, newest first — the writing half of a profile. */
  async listThreadsForCreator(creatorId: string, page: number, pageSize: number, offset: number) {
    const rows = await this.db.query(
      `SELECT t.id, t.title, t.created_at, t.updated_at, t.reply_count, t.last_reply_at,
              t.like_count, t.save_count, c.id AS creator_id, c.handle AS creator_handle,
              b.slug AS board_slug, b.name AS board_name
         FROM forum_threads t
         JOIN creators c ON c.id = t.creator_id
         JOIN forum_boards b ON b.id = t.board_id
        WHERE t.creator_id = $1 AND t.hidden_at IS NULL
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [creatorId, pageSize, offset],
    );
    const total = Number(
      (await this.db.query(
        `SELECT count(*) AS n FROM forum_threads WHERE creator_id = $1 AND hidden_at IS NULL`,
        [creatorId]))[0].n,
    );
    const items = rows.map((r: Record<string, any>) => ({
      ...this.threadSummary(r),
      board: { slug: r.board_slug, name: r.board_name },
    }));
    return { creator_id: creatorId, ...pageOf(items, total, page, pageSize) };
  }
}
