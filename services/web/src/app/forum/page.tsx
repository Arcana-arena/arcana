/**
 * The forum's front door.
 *
 * THE COUNTS ARE THE SERVICE'S. Nothing here counts threads or works out when
 * a board was last active — both arrive decided, from the one query that knows
 * which threads are hidden. A page that counted its own would disagree with the
 * board it links to the first time a moderator acted. The totals strip only
 * adds up what the boards already say.
 *
 * READABLE WITH NO SESSION, like every public surface here. The only thing a
 * signed-out visitor is told is that writing needs a profile — and it is told
 * once, at the bottom, rather than as a wall in front of the content.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent } from '@/lib/api';
import { ABSENT, ago, utc } from '@/lib/format';
import { getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Failed } from '@/components/ds/states';
import type { Board } from '@/lib/social';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Forum — ARCANA',
  description:
    'Discussion of agents, strategies and markets. Nothing said here changes an agent’s score.',
};

export default async function ForumPage() {
  const [r, s] = await Promise.all([
    agent<{ items: Board[] }>('/v1/forum/boards'),
    getSession(),
  ]);
  const signedIn = s.state === 'signed_in';

  const boards = r.ok ? r.data.items : [];
  const totalThreads = boards.reduce((n, b) => n + b.thread_count, 0);
  const latest = boards
    .map((b) => b.last_activity_at)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);

  return (
    <div className="page">
      <Header current="forum" />

      <div className="sec" style={{ paddingTop: 36, paddingBottom: 24 }}>
        <div className="fm-hero">
          <div style={{ maxWidth: 680 }}>
            <div className="fm-kicker">Community</div>
            <h1 style={{ fontSize: 28, marginTop: 6 }}>Forum</h1>
            <p className="m2" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
              Anything about trading, agents and strategy. This is the social layer and it sits on
              top of the record — <strong>nothing written here moves a score, a rank or a
              decision</strong>. An agent is never told what was said about it.
            </p>
          </div>
          {r.ok ? (
            <div className="fm-stats">
              <div className="fm-stat">
                <div className="fm-stat-v">{boards.length}</div>
                <div className="fm-stat-k">Boards</div>
              </div>
              <div className="fm-stat">
                <div className="fm-stat-v">{totalThreads}</div>
                <div className="fm-stat-k">Threads</div>
              </div>
              <div className="fm-stat">
                <div className="fm-stat-v" title={latest ? utc(latest) : undefined}>
                  {latest ? ago(latest) : ABSENT}
                </div>
                <div className="fm-stat-k">Last post</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 24, paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="The boards" error={r} />
        ) : (
          <div className="fm-list">
            <div className="fm-head">
              <span>Board</span>
              <span style={{ textAlign: 'right' }}>Threads</span>
              <span style={{ textAlign: 'right' }}>Last activity</span>
            </div>
            {boards.map((b) => (
              <div key={b.slug} className="fm-row">
                <div className="fm-main">
                  <span className="fm-glyph" aria-hidden="true">
                    {Array.from(b.name)[0] ?? '#'}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/forum/${b.slug}`} className="fm-title">
                      {b.name}
                    </Link>
                    <div className="fm-desc">{b.description}</div>
                  </div>
                </div>
                <div className="fm-cols">
                  <div className="fm-num" style={{ fontSize: 16 }}>
                    {b.thread_count}
                    <span className="fm-unit">{b.thread_count === 1 ? 'THREAD' : 'THREADS'}</span>
                  </div>
                  <div className="fm-when">
                    {/* "No activity yet" and "we could not find out" are not the
                        same thing, and only the first one can be true here: the
                        read succeeded to get this far. */}
                    {b.last_activity_at ? (
                      <>
                        <div title={utc(b.last_activity_at)}>{ago(b.last_activity_at)}</div>
                        <div className="fm-when-sub">{utc(b.last_activity_at).slice(0, 10)}</div>
                      </>
                    ) : (
                      <span className="m3">nothing posted yet</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="fm-note" style={{ marginTop: 18 }}>
          {signedIn ? (
            <>
              Posting uses your creator profile — the same handle your agents and articles are
              published under.
            </>
          ) : (
            <>
              Reading needs nothing. <Link href="/signin">Sign in</Link> to start a thread or
              reply; posting is published under your creator handle.
            </>
          )}{' '}
          Moderation here is deliberately thin: anyone can report, content is hidden rather than
          deleted, and the reason is always shown.
        </div>
      </div>

      <Footer />
    </div>
  );
}
