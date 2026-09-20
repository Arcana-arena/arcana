/**
 * Report and hide — the foundation, and deliberately only that.
 *
 * THREE DECISIONS WORTH THE WORDS.
 *
 * 1. HIDDEN, NEVER DELETED. The row stays and is marked. A reply cut out of the
 *    middle of a thread leaves the replies that answered it looking like
 *    non-sequiturs, and makes moderation invisible — which is how a platform
 *    ends up unable to show that it acted, or that it did not.
 *
 * 2. NO AUTO-HIDE ON A REPORT THRESHOLD. N reports hiding something
 *    automatically is a brigading tool, and the people most worth reading are
 *    the easiest to organise against. Reports queue; a person decides.
 *
 * 3. WHO MAY HIDE: an operator wallet, or the author of the thing the content
 *    sits under — their own thread, their own article, their own post. That
 *    second tier is what makes a spam reply removable in the minutes before an
 *    operator sees it. It is also the sharp edge: a thread author can hide a
 *    reply that disagrees with them. The mitigation is that hiding is on the
 *    record — hidden_by and hidden_reason are stored, the placeholder says the
 *    content was removed, and an operator can reverse it.
 *
 * NOTHING HERE TOUCHES AN AGENT. Hiding a thread about an agent changes nothing
 * about that agent: not its score, not its rank, not one decision it will make.
 * Moderation is a fact about writing.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AUTH_CONFIG, forbidden, type AuthConfig } from '@arcana/auth';
import { pageOf } from '../common/pagination';
import { CreateReportDto } from './dto/forum.dto';

export type ModerationSubject =
  | { kind: 'thread'; id: string }
  | { kind: 'post'; id: string }
  | { kind: 'article'; id: string };

const TABLE = { thread: 'forum_threads', post: 'forum_posts', article: 'articles' } as const;
const REPORT_COLUMN = { thread: 'thread_id', post: 'post_id', article: 'article_id' } as const;

@Injectable()
export class ModerationService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  private isAdmin(wallet: string): boolean {
    return this.cfg.adminWallets.includes(wallet.toLowerCase());
  }

  // ----------------------------------------------------------------- reports

  /**
   * 🔒 Report something.
   *
   * A SECOND REPORT FROM THE SAME PERSON IS NOT AN ERROR AND NOT A SECOND ROW.
   * The unique index in 0056 makes it one objection however many times it is
   * sent, and the response says which of the two happened rather than pretending
   * the duplicate was new — somebody who reported from two devices should not be
   * told they achieved twice as much.
   */
  async report(reporterId: string, subject: ModerationSubject, dto: CreateReportDto) {
    await this.load(subject);
    const rows = await this.db.query(
      `INSERT INTO content_reports (reporter_id, ${REPORT_COLUMN[subject.kind]}, reason, detail)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, created_at`,
      [reporterId, subject.id, dto.reason, dto.detail ?? null],
    );
    if (rows.length === 0) {
      return { recorded: false, already_reported: true, subject };
    }
    return { recorded: true, already_reported: false, id: rows[0].id, created_at: rows[0].created_at, subject };
  }

  /** 👑 The queue. Operator-only: a report names a reporter, and that is theirs. */
  async listReports(status: string | undefined, page: number, pageSize: number, offset: number) {
    const where = status ? `WHERE r.status = $3` : '';
    const params: unknown[] = status ? [pageSize, offset, status] : [pageSize, offset];
    const rows = await this.db.query(
      `SELECT r.id, r.reason, r.detail, r.status, r.created_at, r.reviewed_at,
              r.thread_id, r.post_id, r.article_id,
              c.handle AS reporter_handle
         FROM content_reports r
         JOIN creators c ON c.id = r.reporter_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT $1 OFFSET $2`,
      params,
    );
    const total = Number(
      (await this.db.query(
        `SELECT count(*) AS n FROM content_reports r ${status ? 'WHERE r.status = $1' : ''}`,
        status ? [status] : []))[0].n,
    );
    return pageOf(rows, total, page, pageSize);
  }

  // -------------------------------------------------------------------- hide

  /**
   * 🔒 Hide content, as an operator or as the author it sits under.
   *
   * The reason is required by the DTO and stored on the row, because a removal
   * with no stated cause cannot be told apart from a disagreement being deleted.
   */
  async hide(
    actor: { creatorId: string; wallet: string },
    subject: ModerationSubject,
    reason: string,
  ) {
    const row = await this.load(subject);
    const admin = this.isAdmin(actor.wallet);
    if (!admin && !(await this.mayModerate(actor.creatorId, subject, row))) {
      throw forbidden(
        'forbidden_not_moderator',
        'Hiding this is for an operator, or for the author of the thread, article or post it ' +
          'belongs to. You can report it instead.',
      );
    }
    if (row.hidden_at) {
      return { hidden: true, already_hidden: true, subject };
    }

    await this.db.query(
      `UPDATE ${TABLE[subject.kind]}
          SET hidden_at = now(), hidden_by = $2, hidden_reason = $3
        WHERE id = $1`,
      [subject.id, actor.creatorId, reason.trim()],
    );
    // Reports about this item are now acted on. Left 'open' they would sit in
    // the queue forever and make the queue useless for finding what still needs
    // a decision.
    await this.db.query(
      `UPDATE content_reports
          SET status = 'actioned', reviewed_at = now(), reviewed_by = $2
        WHERE ${REPORT_COLUMN[subject.kind]} = $1 AND status = 'open'`,
      [subject.id, actor.creatorId],
    );
    return { hidden: true, already_hidden: false, subject, by: admin ? 'operator' : 'author' };
  }

  /**
   * 🔒 Put it back.
   *
   * An operator may reverse anything. Anyone else may only reverse what they
   * themselves hid — otherwise an author could undo an operator's decision on
   * their own thread, which would make the operator tier decorative.
   */
  async unhide(actor: { creatorId: string; wallet: string }, subject: ModerationSubject) {
    const row = await this.load(subject);
    if (!row.hidden_at) return { hidden: false, was_hidden: false, subject };

    if (!this.isAdmin(actor.wallet) && row.hidden_by !== actor.creatorId) {
      throw forbidden(
        'forbidden_not_moderator',
        'This was hidden by somebody else. Only an operator, or whoever hid it, can put it back.',
      );
    }
    await this.db.query(
      `UPDATE ${TABLE[subject.kind]}
          SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL
        WHERE id = $1`,
      [subject.id],
    );
    return { hidden: false, was_hidden: true, subject };
  }

  // ----------------------------------------------------------------- helpers

  /** The row, with whatever the authority check will need from it. */
  private async load(subject: ModerationSubject) {
    // A post needs its parent so the author-tier check below can ask who owns
    // the thread or article it sits under. Threads and articles own themselves.
    const extra = subject.kind === 'post' ? ', thread_id, article_id' : '';
    // All three tables carry hidden_at/hidden_by/hidden_reason under the same
    // names (0056), which is what lets one method moderate any of them.
    const rows = await this.db.query(
      `SELECT id, creator_id, hidden_at, hidden_by${extra} FROM ${TABLE[subject.kind]} WHERE id = $1`,
      [subject.id],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`${subject.kind} ${subject.id} not found`);
    }
    return rows[0];
  }

  /**
   * May this creator moderate this item, without being an operator?
   *
   * Yes if it is their own writing, or if it sits under their thread or their
   * article. The second clause is the one that matters: it is what lets the
   * person who started a discussion clear spam out of it.
   */
  private async mayModerate(
    creatorId: string,
    subject: ModerationSubject,
    row: Record<string, any>,
  ): Promise<boolean> {
    if (row.creator_id === creatorId) return true;
    if (subject.kind !== 'post') return false;

    const parent = row.thread_id
      ? await this.db.query(`SELECT creator_id FROM forum_threads WHERE id = $1`, [row.thread_id])
      : await this.db.query(`SELECT creator_id FROM articles WHERE id = $1`, [row.article_id]);
    return parent.length > 0 && parent[0].creator_id === creatorId;
  }
}
