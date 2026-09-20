/**
 * Like and save.
 *
 * A LIKE IS NOT A VOTE ON AN AGENT. It counts on a thread or an article and
 * stops there. Nothing in this file writes to score_snapshots, reputation_score
 * or any column a leaderboard reads, and no query here joins to agents at all —
 * which is the property forum-verify asserts by running the scoring batch
 * before and after a thousand likes and comparing the score.
 *
 * IDEMPOTENCE IS THE DATABASE'S, NOT THIS FILE'S. `ON CONFLICT DO NOTHING`
 * against the partial unique indexes in 0056 means liking twice from two tabs
 * is one like. The obvious alternative — SELECT then INSERT — has a race
 * between the two statements, and the symptom is a count of 2 for one person,
 * which no amount of reading the service code would explain.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { pageOf } from '../common/pagination';
import type { ReactionKind } from './entities';

export type ReactionSubject = { thread_id: string } | { article_id: string };

@Injectable()
export class ReactionsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private parts(subject: ReactionSubject) {
    const isThread = 'thread_id' in subject;
    return {
      isThread,
      table: isThread ? 'forum_threads' : 'articles',
      column: isThread ? 'thread_id' : 'article_id',
      id: isThread ? subject.thread_id : subject.article_id,
    };
  }

  private async assertExists(subject: ReactionSubject) {
    const { table, id, isThread } = this.parts(subject);
    const rows = await this.db.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
    if (rows.length === 0) {
      throw new NotFoundException(`${isThread ? 'Thread' : 'Article'} ${id} not found`);
    }
  }

  /**
   * 🔒 Add a reaction. Returns the counts AFTER the change, read back from the
   * row the trigger updated — not a number this service worked out. A caller
   * that rendered its own optimistic count would disagree with the next reload.
   */
  async add(creatorId: string, kind: ReactionKind, subject: ReactionSubject) {
    await this.assertExists(subject);
    const { column, id } = this.parts(subject);
    await this.db.query(
      `INSERT INTO content_reactions (creator_id, kind, ${column})
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [creatorId, kind, id],
    );
    return this.state(creatorId, subject);
  }

  /** 🔒 Remove it. Removing one that was never there is a success, not a 404. */
  async remove(creatorId: string, kind: ReactionKind, subject: ReactionSubject) {
    await this.assertExists(subject);
    const { column, id } = this.parts(subject);
    await this.db.query(
      `DELETE FROM content_reactions WHERE creator_id = $1 AND kind = $2 AND ${column} = $3`,
      [creatorId, kind, id],
    );
    return this.state(creatorId, subject);
  }

  /** The counts on one item, plus what this viewer has done to it. */
  async state(creatorId: string | null, subject: ReactionSubject) {
    const { table, column, id } = this.parts(subject);
    const rows = await this.db.query(
      `SELECT like_count, save_count FROM ${table} WHERE id = $1`, [id]);
    const mine = creatorId
      ? await this.db.query(
          `SELECT kind FROM content_reactions WHERE creator_id = $1 AND ${column} = $2`,
          [creatorId, id],
        )
      : [];
    const kinds = new Set(mine.map((r: { kind: string }) => r.kind));
    return {
      ...subject,
      like_count: Number(rows[0].like_count),
      save_count: Number(rows[0].save_count),
      // `null` where there is no viewer, NOT false. "Nobody is signed in" and
      // "signed in and has not liked this" are different, and a page that drew
      // an empty heart for the first would be inviting a click that cannot work.
      liked: creatorId ? kinds.has('like') : null,
      saved: creatorId ? kinds.has('save') : null,
    };
  }

  /**
   * 🔒 What this viewer has liked or saved among the items on one page.
   *
   * ASKED FOR IN A BATCH because the alternative is one request per row, and a
   * board listing a hundred threads would make a hundred of them. The public
   * read of those threads stays anonymous and cacheable; this is the only call
   * that needs a session, and a signed-out visitor never makes it.
   */
  async mine(creatorId: string, threadIds: string[], articleIds: string[]) {
    if (threadIds.length === 0 && articleIds.length === 0) {
      return { threads: {}, articles: {} };
    }
    const rows = await this.db.query(
      `SELECT kind, thread_id, article_id FROM content_reactions
        WHERE creator_id = $1
          AND (thread_id = ANY($2::uuid[]) OR article_id = ANY($3::uuid[]))`,
      [creatorId, threadIds, articleIds],
    );

    const threads: Record<string, { liked: boolean; saved: boolean }> = {};
    const articles: Record<string, { liked: boolean; saved: boolean }> = {};
    for (const id of threadIds) threads[id] = { liked: false, saved: false };
    for (const id of articleIds) articles[id] = { liked: false, saved: false };
    for (const r of rows as Array<{ kind: string; thread_id: string | null; article_id: string | null }>) {
      const bucket = r.thread_id ? threads[r.thread_id] : articles[r.article_id as string];
      if (!bucket) continue;
      if (r.kind === 'like') bucket.liked = true;
      if (r.kind === 'save') bucket.saved = true;
    }
    return { threads, articles };
  }

  /**
   * 🔒 Everything this creator saved, newest save first.
   *
   * Saves of HIDDEN content are kept in the list and marked, rather than
   * dropped. A reading list that silently loses entries teaches people it is
   * unreliable; one that says "this was removed" is telling them what happened.
   */
  async saved(creatorId: string, page: number, pageSize: number, offset: number) {
    const rows = await this.db.query(
      `SELECT r.created_at AS saved_at,
              t.id AS thread_id, t.title AS thread_title, t.hidden_at AS thread_hidden,
              tb.slug AS board_slug,
              a.id AS article_id, a.title AS article_title
         FROM content_reactions r
         LEFT JOIN forum_threads t ON t.id = r.thread_id
         LEFT JOIN forum_boards tb ON tb.id = t.board_id
         LEFT JOIN articles a ON a.id = r.article_id
        WHERE r.creator_id = $1 AND r.kind = 'save'
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [creatorId, pageSize, offset],
    );
    const total = Number(
      (await this.db.query(
        `SELECT count(*) AS n FROM content_reactions WHERE creator_id = $1 AND kind = 'save'`,
        [creatorId]))[0].n,
    );

    const items = rows.map((r: Record<string, any>) =>
      r.thread_id
        ? {
            kind: 'thread' as const,
            id: r.thread_id,
            title: r.thread_hidden ? null : r.thread_title,
            board: r.board_slug,
            hidden: Boolean(r.thread_hidden),
            saved_at: r.saved_at,
          }
        : {
            kind: 'article' as const,
            id: r.article_id,
            title: r.article_title,
            hidden: false,
            saved_at: r.saved_at,
          },
    );
    return pageOf(items, total, page, pageSize);
  }
}
