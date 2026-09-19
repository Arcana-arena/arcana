/**
 * Every claim recently published, whichever way it went.
 *
 * NOT A HALL OF FAME. Proven, not proven and still running share one list in
 * publication order, because a page that showed only the wins would be exactly
 * the thing this feature was built to replace.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent } from '@/lib/api';
import { fracAsPct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Empty, Failed } from '@/components/ds/states';
import type { ThesisList } from './shapes';
import { VerdictTag, benchmarkLabel } from './shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Theses — ARCANA',
  description: 'Market claims published before the outcome was known, and how they turned out.',
};

export default async function ThesesPage() {
  const r = await agent<ThesisList>('/v1/theses/recent?limit=25');

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
        <h1>Prove this thesis</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 700, lineHeight: 1.55 }}>
          A creator states what they think the market will do, binds it to one of their agents, and
          ARCANA timestamps it. When the deadline passes the result is attached automatically.
          Nothing here can be edited or taken down afterwards.
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="Recent theses" error={r} />
        ) : r.data.items.length === 0 ? (
          <Empty title="No thesis has been published yet">
            The first one will appear here the moment it is, deadline and all.
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
      </div>

      <Footer />
    </div>
  );
}
