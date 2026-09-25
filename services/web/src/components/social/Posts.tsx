import Link from 'next/link';
import { ago, utc } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import type { PostItem } from '@/lib/social';
import { Avatar } from './Avatar';
import { ModerationControls } from './ModerationControls';

export type Viewer = {
  signedIn: boolean;
  creatorId: string | null;
  isOperator: boolean;
};

/**
 * A conversation, in the order it happened.
 *
 * HIDDEN POSTS KEEP THEIR PLACE. A removed reply renders as a marked gap
 * carrying the moderator's reason, not as nothing — take it out of the sequence
 * and the replies that answered it become non-sequiturs, and the fact that
 * anybody moderated anything disappears from the page. This is the same
 * decision the API makes when it sends `body: null` instead of omitting the
 * row.
 *
 * THE ORDER IS THE SERVICE'S. Nothing here sorts. The endpoint returns oldest
 * first with `id` breaking ties, and a component that re-sorted would still
 * show every post — in a sequence that is nobody's.
 */
export function Posts({
  posts,
  viewer,
  parentAuthorId,
  revalidate,
  offset = 0,
  emptyNote = 'No replies yet.',
}: {
  posts: PostItem[];
  viewer: Viewer;
  /** The author of the thread or article these sit under; they may hide them. */
  parentAuthorId: string | null;
  revalidate: string;
  /** How many posts precede this page, so the #n permalinks count the whole conversation. */
  offset?: number;
  emptyNote?: string;
}) {
  if (posts.length === 0) {
    return <div className="fm-empty">{emptyNote}</div>;
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {posts.map((p, i) => {
        const mine = viewer.creatorId !== null && viewer.creatorId === p.author.id;
        const ownsParent = viewer.creatorId !== null && viewer.creatorId === parentAuthorId;
        const canHide = viewer.isOperator || mine || ownsParent;

        return (
          <li key={p.id} id={`p-${p.id}`} className="fm-post" style={{ scrollMarginTop: 16 }}>
            <div className="fm-post-hd">
              <Avatar handle={p.author.handle} small />
              <Link href={`/creators/${p.author.id}`}>{p.author.handle}</Link>
              {p.author.id === parentAuthorId ? <span className="tag tag-accent">AUTHOR</span> : null}
              <span className="mono m3" style={{ fontSize: 11 }} title={utc(p.created_at)}>
                {ago(p.created_at)}
              </span>
              {p.updated_at !== p.created_at && !p.hidden ? (
                <span className="m3" style={{ fontSize: 11 }} title={`Edited ${utc(p.updated_at)}`}>
                  edited
                </span>
              ) : null}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
                <ModerationControls
                  subject={{ kind: 'post', id: p.id }}
                  revalidate={revalidate}
                  signedIn={viewer.signedIn}
                  canHide={canHide}
                  hidden={p.hidden !== null}
                  canUnhide={viewer.isOperator}
                />
                <a href={`#p-${p.id}`} className="fm-idx" title="Link to this reply">
                  #{offset + i + 1}
                </a>
              </span>
            </div>

            {p.hidden ? (
              <div
                className="m3"
                style={{ fontSize: 12, padding: '12px 16px', lineHeight: 1.55, borderLeft: '2px dashed var(--ink-3)' }}
              >
                This reply was hidden by moderation on{' '}
                <span className="mono">{utc(p.hidden.at)}</span>. Reason given:{' '}
                <em>{p.hidden.reason}</em>. It is kept in place so the replies around it still
                read as a conversation.
              </div>
            ) : (
              <div className="fm-post-bd">
                <Markdown source={p.body ?? ''} className="fm-body" />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
