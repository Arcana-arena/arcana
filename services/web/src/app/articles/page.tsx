/**
 * Articles, newest first.
 *
 * MOST OF THESE CARRY NO FORECAST, and the page says so rather than implying
 * otherwise by decorating the ones that do. An article is writing; a thesis is
 * a claim with a deadline and an automatic verdict, and the two are kept
 * visually distinct here for the same reason they are separate tables.
 *
 * THE COUNTS ARE THE SERVICE'S — likes, saves and comments are maintained by
 * trigger in 0056 and arrive already decided.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import { utc } from '@/lib/format';
import { getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Failed } from '@/components/ds/states';
import { Tag } from '@/components/ds/primitives';
import { Pager } from '@/components/ds/nav';
import type { ArticleCard, Paged } from '@/lib/social';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Articles — ARCANA',
  description: 'Writing by the people who run the agents. Some of it carries a claim; most does not.',
};

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Number(pageRaw) : 1;

  const [r, s] = await Promise.all([
    agent<Paged<ArticleCard>>(`/v1/articles${qs({ page, page_size: 25 })}`),
    getSession(),
  ]);
  const canWrite = s.state === 'signed_in' && s.session.creator_id !== null;

  return (
    <div className="page">
      <Header current="articles" />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 24 }}>Articles</h1>
            <p className="m2" style={{ fontSize: 13, maxWidth: 680, marginTop: 8, lineHeight: 1.6 }}>
              Writing by the people who run the agents. An article may name one of its
              author&rsquo;s agents, in which case a live card under it reads that agent&rsquo;s own
              numbers — and it may carry a thesis, which is a claim with a deadline. Most carry
              neither, and that is the intended shape.
            </p>
          </div>
          {canWrite ? (
            <Link href="/me/articles/new" className="btn btn-primary" style={{ alignSelf: 'start' }}>
              Write an article
            </Link>
          ) : null}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 8, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="The articles" error={r} />
        ) : r.data.items.length === 0 ? (
          <div className="m3" style={{ fontSize: 13, padding: '20px 0' }}>
            Nothing published yet.
          </div>
        ) : (
          <div style={{ border: '1px solid var(--color-divider)' }}>
            {r.data.items.map((a, i) => (
              <div
                key={a.id}
                style={{
                  padding: '14px 16px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--color-divider)',
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Link href={`/articles/${a.id}`} style={{ fontSize: 14.5 }}>
                    {a.title}
                  </Link>
                  {a.thesis_id ? <Tag tone="accent">carries a thesis</Tag> : null}
                  {a.agent ? <Tag tone="outline">{a.agent.name ?? 'linked agent'}</Tag> : null}
                </div>
                <div className="m3" style={{ fontSize: 11.5, marginTop: 5 }}>
                  {a.creator ? (
                    <>
                      <Link href={`/creators/${a.creator.id}`} className="m2">
                        {a.creator.handle}
                      </Link>{' '}
                      ·{' '}
                    </>
                  ) : null}
                  <span className="mono">{utc(a.created_at)}</span>
                  {a.comment_count > 0 ? <> · {a.comment_count} comments</> : null}
                  {a.like_count > 0 ? <> · ♥ {a.like_count}</> : null}
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
            hrefFor={(p) => `/articles${qs({ page: p > 1 ? p : null })}`}
            unit="articles"
          />
        </div>
      ) : null}

      <Footer />
    </div>
  );
}
