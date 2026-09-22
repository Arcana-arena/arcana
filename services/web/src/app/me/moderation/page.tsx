/**
 * The report queue, for operators.
 *
 * `GET /v1/moderation/reports` has existed since the forum shipped and nothing
 * on the site read it: reports went in and an operator could only find them
 * with psql. This page reads the queue and links each report to the thing it
 * is about. It takes no action of its own — hiding stays on the content's own
 * page, where the operator can read what they are hiding first, and a hide
 * there marks every open report about it as actioned.
 *
 * WHO SEES IT. The link is drawn only for `is_operator`, but that is courtesy;
 * the endpoint is behind AdminGuard and a non-operator gets its refusal here.
 * Reports name their reporter, which is why the queue is not public.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { qs } from '@/lib/api';
import { utc } from '@/lib/format';
import type { Paged } from '@/lib/social';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Pager } from '@/components/ds/nav';
import { Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../CreatorNav';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Moderation — ARCANA' };

type Report = {
  id: string;
  reason: string;
  detail: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
  reviewed_at: string | null;
  thread_id: string | null;
  post_id: string | null;
  article_id: string | null;
  reporter_handle: string;
  post_thread_id: string | null;
  post_article_id: string | null;
  thread_title: string | null;
  article_title: string | null;
  subject_hidden_at: string | null;
};

const STATUSES = ['open', 'actioned', 'dismissed', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

/** Where the reported thing can be read, and what to call it. */
function subjectOf(r: Report): { what: string; title: string | null; href: string | null } {
  if (r.thread_id) return { what: 'thread', title: r.thread_title, href: `/forum/thread/${r.thread_id}` };
  if (r.article_id) return { what: 'article', title: r.article_title, href: `/articles/${r.article_id}` };
  if (r.post_id) {
    if (r.post_thread_id) {
      return { what: 'reply in', title: r.thread_title, href: `/forum/thread/${r.post_thread_id}` };
    }
    if (r.post_article_id) {
      return { what: 'comment on', title: r.article_title, href: `/articles/${r.post_article_id}` };
    }
    return { what: 'post', title: null, href: null };
  }
  return { what: 'unknown', title: null, href: null };
}

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const { page: pageRaw, status: statusRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Math.floor(Number(pageRaw)) : 1;
  const status: StatusFilter = (STATUSES as readonly string[]).includes(statusRaw ?? '')
    ? (statusRaw as StatusFilter)
    : 'open';

  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fmoderation');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared.
        </StatusBox>
      </Shell>
    );
  }
  const creatorId = s.session.creator_id ?? undefined;
  if (s.session.is_operator !== true) {
    return (
      <Shell creatorId={creatorId}>
        <h1>Moderation</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            The report queue is for operators, because each report names who made it. To flag
            something, use the report control on the thread, article or reply itself.
          </Callout>
        </div>
      </Shell>
    );
  }

  const r = await authed<Paged<Report>>(
    `/v1/moderation/reports${qs({ status: status === 'all' ? null : status, page, page_size: 50 })}`,
  );
  const href = (st: StatusFilter, p: number) =>
    `/me/moderation${qs({ status: st === 'open' ? null : st, page: p > 1 ? p : null })}`;

  return (
    <Shell creatorId={creatorId} operator>
      <h1>Moderation</h1>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 640, lineHeight: 1.55 }}>
        Reports from signed-in creators, newest first. Open the item to read it in place and hide it
        there if it has to go — hiding marks every open report about it as actioned.
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
        {STATUSES.map((st) => (
          <Link
            key={st}
            href={href(st, 1)}
            className={st === status ? 'btn btn-primary' : 'btn'}
            aria-current={st === status ? 'page' : undefined}
            style={{ padding: '3px 10px', fontSize: 11.5 }}
          >
            {st}
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        {!r.ok ? (
          <Failed what="The report queue" error={r} />
        ) : r.data.items.length === 0 ? (
          <Empty title={status === 'open' ? 'Nothing is waiting' : `No ${status === 'all' ? '' : `${status} `}reports`}>
            {page > 1 ? <Link href={href(status, 1)}>Back to the first page</Link> : null}
          </Empty>
        ) : (
          <>
            <div style={{ border: '1px solid var(--color-divider)' }}>
              {r.data.items.map((rep) => {
                const subj = subjectOf(rep);
                return (
                  <div
                    key={rep.id}
                    style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--color-divider)',
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: '4px 16px',
                      alignItems: 'start',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, lineHeight: 1.4 }}>
                        <strong>{rep.reason}</strong> · {subj.what}{' '}
                        {subj.href ? (
                          <Link href={subj.href}>{subj.title ?? 'untitled'}</Link>
                        ) : (
                          <span className="m3">(no longer linked)</span>
                        )}
                      </div>
                      {rep.detail ? (
                        <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                          &ldquo;{rep.detail}&rdquo;
                        </div>
                      ) : null}
                      <div className="mono m3" style={{ fontSize: 10, marginTop: 4 }}>
                        by {rep.reporter_handle} · {utc(rep.created_at)}
                        {rep.reviewed_at ? ` · reviewed ${utc(rep.reviewed_at)}` : ''}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                      <Tag>{rep.status}</Tag>
                      {rep.subject_hidden_at ? (
                        <span className="mono m3" style={{ fontSize: 10 }}>
                          hidden {utc(rep.subject_hidden_at)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {r.ok ? (
          <Pager
            page={r.data.page}
            pageSize={r.data.page_size}
            total={r.data.total}
            hasMore={r.data.has_more}
            hrefFor={(p) => href(status, p)}
            unit="reports"
          />
        ) : null}
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
        <CreatorNav current="Moderation" creatorId={creatorId} operator={operator} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}
