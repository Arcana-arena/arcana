/**
 * Every claim recently published, whichever way it went.
 *
 * NOT A HALL OF FAME. Proven, not proven and still running share one list in
 * publication order, because a page that showed only the wins would be exactly
 * the thing this feature was built to replace.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import { getSession } from '@/lib/session';
import { fracAsPct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Pager } from '@/components/ds/nav';
import { Empty, Failed } from '@/components/ds/states';
import type { ThesisList } from './shapes';
import { VerdictTag, benchmarkLabel } from './shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Theses — ARCANA',
  description: 'Market claims published before the outcome was known, and how they turned out.',
};

type PagedTheses = ThesisList & { page: number; page_size: number; total: number; has_more: boolean };

export default async function ThesesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Math.floor(Number(pageRaw)) : 1;

  const [r, s] = await Promise.all([
    agent<PagedTheses>(`/v1/theses/recent${qs({ page, page_size: 25 })}`),
    getSession(),
  ]);
  const canPublish = s.state === 'signed_in' && s.session.creator_id !== null;

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1>Prove this thesis</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 700, lineHeight: 1.55 }}>
              A creator states what they think the market will do, binds it to one of their agents,
              and ARCANA timestamps it. When the deadline passes the result is attached
              automatically. Nothing here can be edited or taken down afterwards.
            </div>
          </div>
          {canPublish ? (
            <Link href="/me/theses/new" className="btn btn-primary" style={{ alignSelf: 'start' }}>
              Publish a thesis
            </Link>
          ) : null}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="Recent theses" error={r} />
        ) : r.data.items.length === 0 ? (
          page > 1 ? (
            <Empty title="Nothing on this page">
              <Link href="/theses">Back to the first page</Link>
            </Empty>
          ) : (
            <Empty title="No thesis has been published yet">
              The first one will appear here the moment it is, deadline and all.
            </Empty>
          )
        ) : (
          <div style={{ border: '1px solid var(--color-divider)' }}>
            {r.data.items.map((t) => (
              <div
                key={t.id}
                style={{
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--color-divider)',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: '6px 16px',
                  alignItems: 'start',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <Link href={`/theses/${t.id}`} style={{ fontSize: 14, lineHeight: 1.4 }}>
                    {t.claim}
                  </Link>
                  <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                    {t.creator.handle} · {t.agent.name} · vs {benchmarkLabel(t.benchmark)}
                  </div>
                  <div className="mono m3" style={{ fontSize: 10, marginTop: 3 }}>
                    published {utc(t.created_at)} · {t.status === 'pending' ? 'resolves' : 'resolved'}{' '}
                    {utc(t.resolves_at)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <VerdictTag status={t.status} />
                  {t.result ? (
                    <div className="mono m3" style={{ fontSize: 10.5, marginTop: 4 }}>
                      {fracAsPct(t.result.agent_return)} vs {fracAsPct(t.result.benchmark_return)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {r.ok && r.data.total > 0 ? (
          <Pager
            page={r.data.page}
            pageSize={r.data.page_size}
            total={r.data.total}
            hasMore={r.data.has_more}
            hrefFor={(p) => `/theses${qs({ page: p > 1 ? p : null })}`}
            unit="theses"
          />
        ) : null}
      </div>

      <Footer />
    </div>
  );
}
