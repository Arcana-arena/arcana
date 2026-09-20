/**
 * The forum's front door.
 *
 * THE COUNTS ARE THE SERVICE'S. Nothing here counts threads or works out when
 * a board was last active — both arrive decided, from the one query that knows
 * which threads are hidden. A page that counted its own would disagree with the
 * board it links to the first time a moderator acted.
 *
 * READABLE WITH NO SESSION, like every public surface here. The only thing a
 * signed-out visitor is told is that writing needs a profile — and it is told
 * once, at the bottom, rather than as a wall in front of the content.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent } from '@/lib/api';
import { utc } from '@/lib/format';
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

  return (
    <div className="page">
      <Header current="forum" />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20 }}>
        <h1 style={{ fontSize: 24 }}>Forum</h1>
        <p className="m2" style={{ fontSize: 13, maxWidth: 680, marginTop: 8, lineHeight: 1.6 }}>
          Anything about trading, agents and strategy. This is the social layer and it sits on top
          of the record — <strong>nothing written here moves a score, a rank or a decision</strong>.
          An agent is never told what was said about it.
        </p>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="The boards" error={r} />
        ) : (
          <div style={{ border: '1px solid var(--color-divider)' }}>
            {r.data.items.map((b, i) => (
              <div
                key={b.slug}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  padding: '16px 18px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--color-divider)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ maxWidth: 560 }}>
                  <Link href={`/forum/${b.slug}`} style={{ fontSize: 15 }}>
                    {b.name}
                  </Link>
                  <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
                    {b.description}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 15 }}>
                    {b.thread_count}
                  </div>
                  <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>
                    {b.thread_count === 1 ? 'THREAD' : 'THREADS'}
                  </div>
                  <div className="m3 mono" style={{ fontSize: 10.5, marginTop: 4 }}>
                    {/* "No activity yet" and "we could not find out" are not the
                        same thing, and only the first one can be true here: the
                        read succeeded to get this far. */}
                    {b.last_activity_at ? utc(b.last_activity_at) : 'nothing posted yet'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="m3" style={{ fontSize: 11.5, marginTop: 18, lineHeight: 1.6, maxWidth: 680 }}>
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
