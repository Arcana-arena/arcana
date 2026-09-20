import Link from 'next/link';
import { agent } from '@/lib/api';
import { utcDate } from '@/lib/format';
import { Tag } from '@/components/ds/primitives';
import { Unavailable } from '@/components/ds/states';

/**
 * What people have written about this agent.
 *
 * THE DIRECTION OF THIS RELATIONSHIP IS THE WHOLE POINT. The page reads the
 * articles; the agent does not. There is no path from an article, a thread or a
 * comment into a mandate, a prompt or a decision — the social tables hold no
 * reference the decision engine can follow, and infra/verify/forum-verify.mjs
 * proves it by giving two identical agents different write-ups and comparing
 * the decisions they make.
 *
 * WHICH IS WHY THIS BLOCK IS SAFE TO SHOW ON AN AGENT'S OWN PAGE. A reader
 * seeing praise beside a score might reasonably wonder whether one produced the
 * other. It did not, it cannot, and the note under the list says so rather than
 * leaving them to assume.
 *
 * AN EMPTY LIST RENDERS NOTHING AT ALL. A heading over "no articles" on every
 * agent that nobody has written about would be a permanent reproach on most
 * pages; a failed read still says so, because that is a different fact.
 */

type ArticleRef = {
  id: string;
  title: string;
  thesis_id: string | null;
  created_at: string;
  comment_count: number;
  like_count: number;
  creator?: { id: string; handle: string };
};

export async function WrittenAbout({ id }: { id: string }) {
  const r = await agent<{ items: ArticleRef[]; total: number }>(
    `/v1/agents/${id}/articles?page_size=10`,
  );

  if (r.ok && r.data.items.length === 0) return null;

  return (
    <section style={{ marginTop: 34 }}>
      <div className="sec-hd" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <h2>Written about this agent</h2>
      </div>

      {!r.ok ? (
        <Unavailable reason={r.reason} />
      ) : (
        <div style={{ border: '1px solid var(--color-divider)' }}>
          {r.data.items.map((a, i) => (
            <div
              key={a.id}
              style={{
                padding: '12px 14px',
                borderTop: i === 0 ? 'none' : '1px solid var(--color-divider)',
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Link href={`/articles/${a.id}`} style={{ fontSize: 13.5 }}>
                  {a.title}
                </Link>
                {a.thesis_id ? <Tag tone="accent">carries a thesis</Tag> : null}
              </div>
              <div className="m3" style={{ fontSize: 11, marginTop: 3 }}>
                {a.creator ? (
                  <>
                    <Link href={`/creators/${a.creator.id}`} className="m2">
                      {a.creator.handle}
                    </Link>{' '}
                    ·{' '}
                  </>
                ) : null}
                <span className="mono">{utcDate(a.created_at)}</span>
                {a.comment_count > 0 ? ` · ${a.comment_count} comments` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="m3" style={{ fontSize: 11, marginTop: 8, maxWidth: 680, lineHeight: 1.55 }}>
        Writing by its owner, and by anyone else who bound an article to it. None of it reaches
        the agent: it is never given an article, a thread or a comment, and nothing here is an
        input to its score or its decisions.
      </div>
    </section>
  );
}
