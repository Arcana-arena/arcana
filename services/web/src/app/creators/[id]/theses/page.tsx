/**
 * One creator's forecasting record.
 *
 * THE DENOMINATOR IS EVERY THESIS EVER PUBLISHED, and the page says so in
 * words rather than leaving it to be inferred from a percentage. Three out of
 * three reads very differently from three out of ten, and a creator cannot
 * withdraw the ones that stopped looking likely — the still-running claims are
 * counted in the denominator too.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent } from '@/lib/api';
import { fracAsPct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Empty, Failed } from '@/components/ds/states';
import type { CreatorTheses } from '../../../theses/shapes';
import { VerdictTag, benchmarkLabel } from '../../../theses/shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Creator theses — ARCANA' };

export default async function CreatorThesesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const r = await agent<CreatorTheses>(`/v1/creators/${id}/theses`);
  if (!r.ok && r.status === 404) notFound();

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
        <div className="m3" style={{ fontSize: 11, letterSpacing: '0.08em' }}>
          FORECASTING RECORD
        </div>
        <h1 style={{ marginTop: 6 }}>
          <Link href={`/creators/${id}`}>
            {r.ok && r.data.items[0] ? r.data.items[0].creator.handle : 'Creator'}
          </Link>
        </h1>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="This creator's theses" error={r} />
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                border: '1px solid var(--color-divider)',
              }}
            >
              <Figure label="Published" value={String(r.data.record.published)} />
              <Figure label="Proven" value={String(r.data.record.proven)} />
              <Figure
                label="Proven rate"
                value={
                  r.data.record.proven_rate === null
                    ? '—'
                    : fracAsPct(r.data.record.proven_rate, 1)
                }
              />
            </div>
            <div className="m3" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.55, maxWidth: 720 }}>
              {r.data.record.basis}
            </div>

            {r.data.items.length === 0 ? (
              <div style={{ marginTop: 20 }}>
                <Empty title="This creator has published no thesis yet">
                  A creator with no record is not the same as a creator with a bad one, and this
                  page will not imply otherwise.
                </Empty>
              </div>
            ) : (
              <div style={{ border: '1px solid var(--color-divider)', marginTop: 20 }}>
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
                      <Link href={`/theses/${t.id}`} style={{ fontSize: 13.5, lineHeight: 1.4 }}>
                        {t.claim}
                      </Link>
                      <div className="m3" style={{ fontSize: 11, marginTop: 4 }}>
                        {t.agent.name} · vs {benchmarkLabel(t.benchmark)}
                      </div>
                      <div className="mono m3" style={{ fontSize: 10, marginTop: 3 }}>
                        {utc(t.created_at)} → {utc(t.resolves_at)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <VerdictTag status={t.status} />
                      {t.result ? (
                        <div className="mono m3" style={{ fontSize: 10.5, marginTop: 4 }}>
                          {fracAsPct(t.result.agent_return)} vs{' '}
                          {fracAsPct(t.result.benchmark_return)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '12px 16px', borderRight: '1px solid var(--color-divider)' }}>
      <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 19, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}
