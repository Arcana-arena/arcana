/**
 * The shapes the social endpoints answer with.
 *
 * WRITTEN OUT RATHER THAN INFERRED, and every optional field is optional here
 * because it is optional there. The two that matter:
 *
 *   `body: string | null` — null means the content was hidden by moderation.
 *   It is NOT the empty string, and a page must render the two differently:
 *   "removed, and here is why" against "somebody posted nothing".
 *
 *   `liked / saved: boolean | null` — null means nobody is signed in, so the
 *   question was never asked. A page that drew an empty heart for that case
 *   would be inviting a click that cannot work.
 */

export type Author = { id: string; handle: string };

export type HiddenNote = { at: string; reason: string } | null;

export type Board = {
  slug: string;
  name: string;
  description: string;
  thread_count: number;
  last_activity_at: string | null;
};

export type ThreadSummary = {
  id: string;
  title: string;
  author: Author;
  created_at: string;
  updated_at: string;
  reply_count: number;
  last_reply_at: string | null;
  like_count: number;
  save_count: number;
  board?: { slug: string; name: string };
};

export type ThreadDetail = {
  id: string;
  board: { slug: string; name: string };
  /** null when hidden. */
  title: string | null;
  body: string | null;
  author: Author;
  created_at: string;
  updated_at: string;
  reply_count: number;
  last_reply_at: string | null;
  like_count: number;
  save_count: number;
  hidden: HiddenNote;
};

export type PostItem = {
  id: string;
  author: Author;
  body: string | null;
  created_at: string;
  updated_at: string;
  hidden: HiddenNote;
};

export type Paged<T> = {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
};

export type ReactionState = {
  like_count: number;
  save_count: number;
  liked: boolean | null;
  saved: boolean | null;
};

export type MyReactions = {
  threads: Record<string, { liked: boolean; saved: boolean }>;
  articles: Record<string, { liked: boolean; saved: boolean }>;
};

export type ArticleCard = {
  id: string;
  title: string;
  thesis_id: string | null;
  agent: { id: string; name: string | null } | null;
  created_at: string;
  updated_at: string;
  like_count: number;
  save_count: number;
  comment_count: number;
  creator?: Author;
};

/** What a subject looks like on the wire. Exactly one of the three. */
export type Subject =
  | { kind: 'thread'; id: string }
  | { kind: 'post'; id: string }
  | { kind: 'article'; id: string };

export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'hate', label: 'Hate speech or racism' },
  { value: 'harassment', label: 'Harassment of a person' },
  { value: 'scam', label: 'Scam or impersonation' },
  { value: 'off_topic', label: 'Off topic for this board' },
  { value: 'other', label: 'Something else' },
] as const;

/** The API path a subject's social routes hang from. */
export function subjectPath(s: Subject): string {
  if (s.kind === 'thread') return `/v1/forum/threads/${s.id}`;
  if (s.kind === 'post') return `/v1/forum/posts/${s.id}`;
  return `/v1/articles/${s.id}`;
}
