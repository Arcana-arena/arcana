/**
 * An article, and the claim it carries if it carries one.
 *
 * MOST ARTICLES HAVE NO THESIS, and that is the intended shape. Requiring a
 * forecast on every piece of writing would fill the record with claims nobody
 * meant to make; a record of few, deliberate ones says more.
 *
 * The prose is editable. The thesis under it is not, and the page says which
 * is which — an article whose body could be rewritten around a claim that had
 * already resolved would otherwise let the framing move after the result.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent } from '@/lib/api';
import { fracAsPct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Failed } from '@/components/ds/states';
import { LinkedAgentCard } from '@/components/LinkedAgentCard';
import type { Thesis } from '../../theses/shapes';
import { VerdictTag, benchmarkLabel } from '../../theses/shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Article — ARCANA' };

type ArticleRead = {
  id: string;
  creator: { id: string; handle: string };
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  thesis: Thesis | null;
};

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await agent<ArticleRead>(`/v1/articles/${id}`);
  if (!r.ok && r.status === 404) notFound();

  return (
    <div className="page">
      <Header />

      {!r.ok ? (
        <div className="sec" style={{ paddingTop: 32 }}>
          <Failed what="This article" error={r} />
        </div>
      ) : (
        <>
          <div className="sec" style={{ paddingTop: 32, paddingBottom: 16, borderBottom: 'none' }}>
            <h1 style={{ fontSize: 26, lineHeight: 1.25, maxWidth: 760 }}>{r.data.title}</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 8 }}>
              <Link href={`/creators/${r.data.creator.id}`}>{r.data.creator.handle}</Link>
              {' · '}
              <span className="mono">{utc(r.data.created_at)}</span>
              {r.data.updated_at !== r.data.created_at ? (
                <>
                  {' · '}
                  <span className="mono m3" title="The prose was edited. A thesis attached to it was not — that binding is fixed once set.">
                    edited {utc(r.data.updated_at)}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.7,
                maxWidth: 720,
                whiteSpace: 'pre-wrap',
              }}
            >
              {r.data.body}
            </div>

            {r.data.thesis ? (
              <>
                <h2 style={{ marginTop: 32, fontSize: 15 }}>The claim this article made</h2>

                <div style={{ border: '1px solid var(--color-divider)', marginTop: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '14px 16px',
                      borderBottom: '1px solid var(--color-divider)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Link href={`/theses/${r.data.thesis.id}`} style={{ fontSize: 14, maxWidth: 560 }}>
                      {r.data.thesis.claim}
                    </Link>
                    <VerdictTag status={r.data.thesis.status} />
                  </div>
                  <div className="m3" style={{ fontSize: 11, padding: '10px 16px' }}>
                    vs {benchmarkLabel(r.data.thesis.benchmark)} ·{' '}
                    <span className="mono">
                      {utc(r.data.thesis.created_at)} → {utc(r.data.thesis.resolves_at)}
                    </span>
                  </div>
                  {r.data.thesis.result ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        borderTop: '1px solid var(--color-divider)',
                      }}
                    >
                      <Figure label="Agent" value={fracAsPct(r.data.thesis.result.agent_return)} />
                      <Figure
                        label="Benchmark"
                        value={fracAsPct(r.data.thesis.result.benchmark_return)}
                      />
                      <Figure label="Margin" value={fracAsPct(r.data.thesis.result.margin)} />
                    </div>
                  ) : null}
                </div>

                <Callout tone={r.data.thesis.status === 'pending' ? 'note' : 'warn'}>
                  {r.data.thesis.status === 'pending'
                    ? 'This claim is still running. Its result will attach itself here when the deadline passes, whether or not it goes the author’s way.'
                    : 'This result was attached automatically and is permanent. The article above can be rewritten; the claim, its benchmark and its verdict cannot.'}
                </Callout>

                <h2 style={{ marginTop: 28, fontSize: 15 }}>The agent it rests on</h2>
                <LinkedAgentCard
                  agentId={r.data.thesis.agent.id}
                  agentName={r.data.thesis.agent.name}
                  statusNow={r.data.thesis.agent.status_now}
                />
              </>
            ) : (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 28, lineHeight: 1.55, maxWidth: 700 }}>
                This article carries no thesis. It is writing, not a forecast, and nothing here is
                scored.
              </div>
            )}
          </div>
        </>
      )}

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
      <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}
