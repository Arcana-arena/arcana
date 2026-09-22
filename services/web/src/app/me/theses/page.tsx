/**
 * Your theses — every claim this creator published, the misses included.
 *
 * THE SAME RECORD EVERYONE ELSE READS, from `/v1/creators/:id/theses`. There
 * is no private view of a thesis and no way to withdraw one, so this page is
 * the public list with the door to publish another beside it — not a drafts
 * folder.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { qs } from '@/lib/api';
import { fracAsPct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Pager } from '@/components/ds/nav';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../CreatorNav';
import type { CreatorTheses } from '../../theses/shapes';
import { VerdictTag, benchmarkLabel } from '../../theses/shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your theses — ARCANA' };

type Paged = CreatorTheses & { page: number; page_size: number; total: number; has_more: boolean };

export default async function MyThesesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Math.floor(Number(pageRaw)) : 1;

  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Ftheses');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared.
        </StatusBox>
      </Shell>
    );
  }
  const { creator_id } = s.session;
  const operator = s.session.is_operator === true;
  if (!creator_id) {
    return (
      <Shell operator={operator}>
        <h1>Your theses</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            <strong>This wallet has no creator profile yet</strong>, and a thesis is published under
            one. <Link href="/me">Set up your creator profile</Link> first.
          </Callout>
        </div>
      </Shell>
    );
  }

  const r = await authed<Paged>(`/v1/creators/${creator_id}/theses${qs({ page, page_size: 25 })}`);

  return (
    <Shell creatorId={creator_id} operator={operator}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Your theses</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 620, lineHeight: 1.55 }}>
            Claims you published before the market answered them. None can be edited or withdrawn;
            the verdict is attached when the deadline passes.
          </div>
        </div>
        <Link href="/me/theses/new" className="btn btn-primary">
          Publish a thesis
        </Link>
      </div>

      <div style={{ marginTop: 18 }}>
        {!r.ok ? (
          <Failed what="Your theses" error={r} />
        ) : (
          <>
            <div className="mono m2" style={{ fontSize: 11.5, marginBottom: 10 }}>
              {r.data.record.published} published · {r.data.record.proven} proven
              {r.data.record.proven_rate !== null ? ` · ${fracAsPct(r.data.record.proven_rate, 0)}` : ''}
            </div>
            {r.data.items.length === 0 ? (
              <Empty title={page > 1 ? 'Nothing on this page' : 'You have not published a thesis'}>
                {page > 1 ? (
                  <Link href="/me/theses">Back to the first page</Link>
                ) : (
                  <>
                    A thesis is a claim with a deadline, bound to one of your agents.{' '}
                    <Link href="/me/theses/new">Publish the first one</Link>.
                  </>
                )}
              </Empty>
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
                        {t.agent.name} · vs {benchmarkLabel(t.benchmark)}
                        {t.article ? (
                          <>
                            {' '}· carried by <Link href={`/articles/${t.article.id}`}>{t.article.title}</Link>
                          </>
                        ) : null}
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
            {r.data.total > 0 ? (
              <Pager
                page={r.data.page}
                pageSize={r.data.page_size}
                total={r.data.total}
                hasMore={r.data.has_more}
                hrefFor={(p) => `/me/theses${qs({ page: p > 1 ? p : null })}`}
                unit="theses"
              />
            ) : null}
          </>
        )}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  creatorId,
  operator,
}: {
  children: React.ReactNode;
  creatorId?: string;
  operator?: boolean;
}) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current="Theses" creatorId={creatorId} operator={operator} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}
