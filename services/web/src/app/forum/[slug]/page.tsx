/**
 * One board's threads.
 *
 * ORDERED BY LAST ACTIVITY, AND NOT BY THIS FILE. The service returns them
 * that way — a thread nobody has answered sorts by when it was written — and
 * nothing here re-sorts. A page that did would still show every thread, in a
 * sequence that is nobody's.
 *
 * HIDDEN THREADS ARE NOT LISTED, and that is a deliberate difference from a
 * hidden reply, which stays in place inside a thread. A board is a place to
 * discover things and a removed thread is not one; a permalink to it still
 * answers, with the reason, because somebody holding the link is owed an
 * explanation rather than a 404.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent, qs } from '@/lib/api';
import { utc } from '@/lib/format';
import { getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Failed } from '@/components/ds/states';
import { Pager } from '@/components/ds/nav';
import type { Paged, ThreadSummary } from '@/lib/social';
import { NewThreadForm } from './NewThreadForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Board — ARCANA' };

type BoardThreads = Paged<ThreadSummary> & {
  board: { slug: string; name: string; description: string };
};

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Number(pageRaw) : 1;

  const [r, s] = await Promise.all([
    agent<BoardThreads>(`/v1/forum/boards/${encodeURIComponent(slug)}/threads${qs({ page, page_size: 25 })}`),
    getSession(),
  ]);
  if (!r.ok && r.code === 'board_not_found') notFound();
  const signedIn = s.state === 'signed_in';

  return (
    <div className="page">
      <Header current="forum" />

      <div className="sec" style={{ paddingTop: 28, paddingBottom: 16 }}>
        <div className="m3" style={{ fontSize: 11.5 }}>
          <Link href="/forum">Forum</Link>
        </div>
        <h1 style={{ fontSize: 22, marginTop: 6 }}>{r.ok ? r.data.board.name : slug}</h1>
        {r.ok ? (
          <p className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 680, lineHeight: 1.55 }}>
            {r.data.board.description}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <NewThreadForm board={slug} signedIn={signedIn} />
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 8, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="This board" error={r} />
        ) : r.data.items.length === 0 ? (
          <div className="m3" style={{ fontSize: 13, padding: '20px 0' }}>
            Nothing has been posted here yet. The first thread is yours to write.
          </div>
        ) : (
          <div style={{ border: '1px solid var(--color-divider)' }}>
            {r.data.items.map((t, i) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  padding: '14px 16px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--color-divider)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ maxWidth: 620 }}>
                  <Link href={`/forum/thread/${t.id}`} style={{ fontSize: 14.5 }}>
                    {t.title}
                  </Link>
                  <div className="m3" style={{ fontSize: 11.5, marginTop: 4 }}>
                    <Link href={`/creators/${t.author.id}`} className="m2">
                      {t.author.handle}
                    </Link>{' '}
                    · <span className="mono">{utc(t.created_at)}</span>
                    {t.like_count > 0 ? <> · ♥ {t.like_count}</> : null}
                  </div>
                </div>
                <div style={{ textAlign: 'right', minWidth: 130 }}>
                  <div className="mono" style={{ fontSize: 14 }}>
                    {t.reply_count}
                  </div>
                  <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>
                    {t.reply_count === 1 ? 'REPLY' : 'REPLIES'}
                  </div>
                  <div className="m3 mono" style={{ fontSize: 10.5, marginTop: 3 }}>
                    {t.last_reply_at ? `last ${utc(t.last_reply_at)}` : 'no replies yet'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {r.ok ? (
        <div className="sec" style={{ borderBottom: 'none' }}>
          <Pager
            page={r.data.page}
            pageSize={r.data.page_size}
            total={r.data.total}
            hasMore={r.data.has_more}
            hrefFor={(p) => `/forum/${slug}${qs({ page: p > 1 ? p : null })}`}
            unit="threads"
          />
        </div>
      ) : null}

      <Footer />
    </div>
  );
}
