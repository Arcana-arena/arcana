'use server';

/**
 * Every write the social layer makes, in one place.
 *
 * WHY THESE ARE SHARED AND NOT PER-ROUTE. A reply under a thread and a comment
 * under an article are the same act against the same table; a like on either is
 * the same row. Two copies of each action would be two places to fix the next
 * thing either gets wrong, and the second copy always lags — which is exactly
 * the reasoning that put both behind one `forum_posts` table in 0056.
 *
 * THE SESSION IS NEVER A PARAMETER. `authed()` reads the httpOnly cookie on the
 * server; nothing here takes a wallet, a creator id or a token from the caller,
 * so a client component cannot ask to act as somebody else.
 *
 * FAILURES COME BACK AS THEMSELVES. Each action returns the service's `code`
 * alongside the message, because the two that will actually happen need
 * different screens: `creator_profile_required` is a link to /me, and
 * `rate_limited` is "wait", and flattening them into "could not post" would
 * leave a new visitor stuck with no idea what to do.
 */

import { revalidatePath } from 'next/cache';
import { authed } from './session';
import type { ReactionState, Subject } from './social';
import { subjectPath } from './social';

export type ActionFail = { ok: false; status: number | null; reason: string; code: string | null };
export type ActionOk<T> = { ok: true; data: T };
export type ActionResult<T> = ActionOk<T> | ActionFail;

async function write<T>(
  path: string,
  init: { method?: string; body?: unknown },
  revalidate: string[],
): Promise<ActionResult<T>> {
  const r = await authed<T>(path, init);
  if (r.ok) {
    for (const p of revalidate) revalidatePath(p);
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: r.code };
}

// ------------------------------------------------------------------ threads

export async function createThread(input: { board: string; title: string; body: string }) {
  return write<{ id: string; board: string; created_at: string }>(
    '/v1/forum/threads',
    { method: 'POST', body: input },
    ['/forum', `/forum/${input.board}`],
  );
}

export async function replyToThread(threadId: string, body: string) {
  return write<{ id: string; created_at: string }>(
    `/v1/forum/threads/${threadId}/posts`,
    { method: 'POST', body: { body } },
    [`/forum/thread/${threadId}`, '/forum'],
  );
}

export async function editPost(postId: string, body: string, revalidate: string) {
  return write<{ id: string }>(
    `/v1/forum/posts/${postId}`,
    { method: 'PATCH', body: { body } },
    [revalidate],
  );
}

// ----------------------------------------------------------------- articles

export async function commentOnArticle(articleId: string, body: string) {
  return write<{ id: string; created_at: string }>(
    `/v1/articles/${articleId}/comments`,
    { method: 'POST', body: { body } },
    [`/articles/${articleId}`],
  );
}

export async function createArticle(input: {
  title: string;
  body: string;
  agent_id?: string;
  thesis_id?: string;
}) {
  return write<{ id: string; created_at: string }>(
    '/v1/articles',
    { method: 'POST', body: input },
    ['/articles', '/me'],
  );
}

export async function updateArticle(
  id: string,
  input: { title?: string; body?: string; agent_id?: string },
) {
  return write<{ id: string }>(
    `/v1/articles/${id}`,
    { method: 'PATCH', body: input },
    [`/articles/${id}`, '/articles', '/me'],
  );
}

// ------------------------------------------------------------------- theses

export type ThesisBenchmarkInput =
  | { kind: 'symbol'; symbols: [string] }
  | { kind: 'basket'; symbols: string[] }
  | { kind: 'arcana_index' };

export async function createThesis(input: {
  linked_agent_id: string;
  claim_text: string;
  benchmark_ref: ThesisBenchmarkInput;
  criteria: { comparison: 'gt'; margin_pct: number };
  resolves_at: string;
}) {
  return write<{ id: string; status: string; created_at: string; resolves_at: string; note: string }>(
    '/v1/theses',
    { method: 'POST', body: input },
    ['/theses', '/me/theses', '/me/articles/new'],
  );
}

// ---------------------------------------------------------------- reactions

/**
 * Like or save, on or off.
 *
 * THE COUNTS COME BACK FROM THE SERVICE, and the caller renders those rather
 * than adding one to what it had. An optimistic count is a second arithmetic
 * implementation in the browser — it is right until two tabs disagree, and then
 * it is a number the page invented.
 */
export async function setReaction(
  subject: Subject,
  kind: 'like' | 'save',
  on: boolean,
  revalidate: string,
): Promise<ActionResult<ReactionState>> {
  return write<ReactionState>(
    `${subjectPath(subject)}/reactions/${kind}`,
    { method: on ? 'POST' : 'DELETE' },
    [revalidate],
  );
}

// --------------------------------------------------------------- moderation

export async function reportContent(
  subject: Subject,
  reason: string,
  detail: string | undefined,
  revalidate: string,
) {
  return write<{ recorded: boolean; already_reported: boolean }>(
    `${subjectPath(subject)}/reports`,
    { method: 'POST', body: { reason, ...(detail ? { detail } : {}) } },
    [revalidate],
  );
}

export async function hideContent(subject: Subject, reason: string, revalidate: string) {
  return write<{ hidden: boolean; already_hidden: boolean }>(
    `${subjectPath(subject)}/hide`,
    { method: 'POST', body: { reason } },
    [revalidate],
  );
}

export async function unhideContent(subject: Subject, revalidate: string) {
  return write<{ hidden: boolean; was_hidden: boolean }>(
    `${subjectPath(subject)}/unhide`,
    { method: 'POST' },
    [revalidate],
  );
}
