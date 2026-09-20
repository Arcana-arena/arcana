import Link from 'next/link';
import { utc } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import type { PostItem } from '@/lib/social';
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
  emptyNote = 'No replies yet.',
}: {
  posts: PostItem[];
  viewer: Viewer;
  /** The author of the thread or article these sit under; they may hide them. */
  parentAuthorId: string | null;
  revalidate: string;
  emptyNote?: string;
}) {
  if (posts.length === 0) {
    return (
      <div className="m3" style={{ fontSize: 12.5, padding: '14px 0' }}>
        {emptyNote}
      </div>
    );
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {posts.map((p, i) => {
        const mine = viewer.creatorId !== null && viewer.creatorId === p.author.id;
        const ownsParent = viewer.creatorId !== null && viewer.creatorId === parentAuthorId;
        const canHide = viewer.isOperator || mine || ownsParent;

        return (
          <li
            key={p.id}
            id={`p-${p.id}`}
            style={{
              borderTop: i === 0 ? '1px solid var(--color-divider)' : 'none',
              borderBottom: '1px solid var(--color-divider)',
              padding: '14px 0',
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'baseline',
                flexWrap: 'wrap',
                fontSize: 12,
              }}
            >
              <Link href={`/creators/${p.author.id}`}>{p.author.handle}</Link>
              <span className="mono m3" style={{ fontSize: 11 }}>
                {utc(p.created_at)}
              </span>
              {p.updated_at !== p.created_at && !p.hidden ? (
                <span className="m3" style={{ fontSize: 11 }} title={`Edited ${utc(p.updated_at)}`}>
                  edited
                </span>
              ) : null}
              <span style={{ marginLeft: 'auto' }}>
                <ModerationControls
                  subject={{ kind: 'post', id: p.id }}
                  revalidate={revalidate}
                  signedIn={viewer.signedIn}
                  canHide={canHide}
                  hidden={p.hidden !== null}
                  canUnhide={viewer.isOperator}
                />
              </span>
            </div>

            {p.hidden ? (
              <div
                className="m3"
                style={{
                  fontSize: 12,
                  marginTop: 8,
                  padding: '10px 12px',
                  border: '1px dashed var(--ink-3)',
                  lineHeight: 1.55,
                  maxWidth: 720,
                }}
              >
                This reply was hidden by moderation on{' '}
                <span className="mono">{utc(p.hidden.at)}</span>. Reason given:{' '}
                <em>{p.hidden.reason}</em>. It is kept in place so the replies around it still
                read as a conversation.
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <Markdown source={p.body ?? ''} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
