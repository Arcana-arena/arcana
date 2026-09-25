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
import { ago, utc } from '@/lib/format';
import { getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Failed } from '@/components/ds/states';
import { Pager } from '@/components/ds/nav';
import { Avatar } from '@/components/social/Avatar';
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
  const name = r.ok ? r.data.board.name : slug;

  return (
    <div className="page">
      <Header current="forum" />

      <div className="sec" style={{ paddingTop: 28, paddingBottom: 22 }}>
        <nav className="fm-crumbs" aria-label="Breadcrumb">
          <Link href="/forum">Forum</Link>
          <span aria-hidden="true">/</span>
          <span>{name}</span>
        </nav>
        <div className="fm-main" style={{ marginTop: 14, alignItems: 'center' }}>
          <span className="fm-glyph" aria-hidden="true" style={{ width: 44, height: 44, fontSize: 17 }}>
            {Array.from(name)[0] ?? '#'}
          </span>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 24 }}>{name}</h1>
            {r.ok ? (
              <p className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 680, lineHeight: 1.55 }}>
                {r.data.board.description}
              </p>
            ) : null}
          </div>
        </div>
        <div style={{ marginTop: 18 }}>
          <NewThreadForm board={slug} boardName={name} signedIn={signedIn} />
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 22, paddingBottom: 8, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="This board" error={r} />
        ) : r.data.items.length === 0 ? (
          <div className="fm-empty">
            Nothing has been posted here yet. The first thread is yours to write.
          </div>
        ) : (
          <div className="fm-list">
            <div className="fm-head">
              <span>Thread</span>
              <span style={{ textAlign: 'right' }}>Replies</span>
              <span style={{ textAlign: 'right' }}>Last activity</span>
            </div>
            {r.data.items.map((t) => {
              const last = t.last_reply_at ?? t.created_at;
              return (
                <div key={t.id} className="fm-row">
                  <div className="fm-main">
                    <Avatar handle={t.author.handle} />
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/forum/thread/${t.id}`} className="fm-title" style={{ fontSize: 15 }}>
                        {t.title}
                      </Link>
                      <div className="fm-meta">
                        <Link href={`/creators/${t.author.id}`} className="fm-over">
                          {t.author.handle}
                        </Link>
                        <span aria-hidden="true">·</span>
                        <span className="mono" title={utc(t.created_at)}>
                          {ago(t.created_at)}
                        </span>
                        {t.like_count > 0 ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span title={`${t.like_count} ${t.like_count === 1 ? 'like' : 'likes'}`}>
                              ♥ {t.like_count}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="fm-cols">
                    <div className="fm-num" style={{ fontSize: 15 }}>
                      {t.reply_count}
                      <span className="fm-unit">{t.reply_count === 1 ? 'REPLY' : 'REPLIES'}</span>
                    </div>
                    <div className="fm-when">
                      <div title={utc(last)}>{ago(last)}</div>
                      <div className="fm-when-sub">{t.last_reply_at ? 'last reply' : 'no replies yet'}</div>
                    </div>
                  </div>
                </div>
              );
            })}
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
