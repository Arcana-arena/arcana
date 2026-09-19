/**
 * One thesis: what was claimed, when, against what — and, once the deadline
 * has passed, how it turned out.
 *
 * THE PAGE PRINTS THE VERDICT AND THE ARITHMETIC BEHIND IT. A PROVEN badge on
 * its own is an assertion; the same badge beside the two returns, the window
 * they were measured over, the flows that were removed and the benchmark legs
 * is a claim a reader can disagree with. This platform's whole premise is that
 * the second kind is the only kind worth publishing.
 *
 * THE DISAGREEMENT WITH THE ARCANA SCORE IS SHOWN, NOT SMOOTHED. The thesis
 * return removes recorded deposits and withdrawals; the score deliberately
 * does not. Two honest numbers that differ, each saying which it is, beats one
 * number that quietly picked a side.
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
import type { Thesis } from '../shapes';
import { VerdictTag, benchmarkLabel } from '../shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Thesis — ARCANA' };

export default async function ThesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await agent<Thesis>(`/v1/theses/${id}`);

  // 404 stays a 404. There is deliberately no loading.tsx in this route: a
  // Suspense boundary above notFound() makes the response 200 while the body
  // says the page is missing, and a record that cannot be found must not be
  // served as one that exists.
  if (!r.ok && r.status === 404) notFound();

  return (
    <div className="page">
      <Header />

      {!r.ok ? (
        <div className="sec" style={{ paddingTop: 32 }}>
          <Failed what="This thesis" error={r} />
        </div>
      ) : (
        <>
          <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div className="m3" style={{ fontSize: 11, letterSpacing: '0.08em' }}>
                PROVE THIS THESIS
              </div>
              <VerdictTag status={r.data.status} big />
            </div>

            <h1 style={{ marginTop: 10, fontSize: 24, lineHeight: 1.3, maxWidth: 760 }}>
              {r.data.claim}
            </h1>

            <div className="m2" style={{ fontSize: 12.5, marginTop: 10 }}>
              by{' '}
              <Link href={`/creators/${r.data.creator.id}`}>{r.data.creator.handle}</Link>
              {' · '}
              <span className="mono">published {utc(r.data.created_at)}</span>
              {' · '}
              <span className="mono">
                {r.data.status === 'pending' ? 'resolves' : 'resolved against'}{' '}
                {utc(r.data.resolves_at)}
              </span>
            </div>
          </div>

          <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
            <Callout tone={r.data.status === 'pending' ? 'note' : 'warn'}>
              {r.data.status === 'pending'
                ? `Still running. The verdict is attached automatically when the deadline passes — ` +
                  `nobody decides whether to publish it, and this claim can no longer be edited or ` +
                  `withdrawn.`
                : `Resolved automatically against criteria fixed when it was published. The result ` +
                  `is permanent.`}
            </Callout>

            {/* ------------------------------------------------ the criteria */}
            <div style={{ border: '1px solid var(--color-divider)', marginTop: 20 }}>
              <Row label="Measured against" value={benchmarkLabel(r.data.benchmark)} />
              <Row
                label="Proven when"
                value={
                  r.data.criteria.margin_pct > 0
                    ? `the agent beats the benchmark by more than ${r.data.criteria.margin_pct}%`
                    : 'the agent beats the benchmark'
                }
              />
              <Row
                label="Window"
                value={`${utc(r.data.created_at)} → ${utc(r.data.resolves_at)}`}
                mono
              />
            </div>

            {/* -------------------------------------------------- the result */}
            {r.data.result ? (
              <>
                <h2 style={{ marginTop: 28, fontSize: 15 }}>The result</h2>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    border: '1px solid var(--color-divider)',
                    marginTop: 10,
                  }}
                >
                  <Figure label="Agent" value={fracAsPct(r.data.result.agent_return)} />
                  <Figure label="Benchmark" value={fracAsPct(r.data.result.benchmark_return)} />
                  <Figure
                    label="Margin"
                    value={fracAsPct(r.data.result.margin)}
                    tone={r.data.result.margin > 0 ? 'up' : 'dn'}
                  />
                </div>

                {r.data.result.agent_status_at_resolution &&
                r.data.result.agent_status_at_resolution !== 'active' ? (
                  <Callout tone="warn">
                    The agent was{' '}
                    <strong>{r.data.result.agent_status_at_resolution}</strong> when this was
                    measured. That does not void the thesis and never has: a claim that could be
                    cancelled by pausing the agent would let a creator delete a result they could
                    see coming. The measurement ran to the deadline either way, and this line is
                    here so you can weigh it yourself.
                  </Callout>
                ) : null}

                <details style={{ marginTop: 16 }}>
                  <summary style={{ fontSize: 12.5, cursor: 'pointer' }}>
                    The arithmetic, in full
                  </summary>
                  <pre
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      overflowX: 'auto',
                      background: 'var(--color-surface-2, transparent)',
                      border: '1px solid var(--color-divider)',
                      padding: 12,
                      marginTop: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    {JSON.stringify(r.data.result.measurement, null, 2)}
                  </pre>
                </details>
              </>
            ) : null}

            {/* ---------------------------------------------- the agent card */}
            <h2 style={{ marginTop: 28, fontSize: 15 }}>The agent this rests on</h2>
            <LinkedAgentCard
              agentId={r.data.agent.id}
              agentName={r.data.agent.name}
              statusNow={r.data.agent.status_now}
            />

            <div className="m3" style={{ fontSize: 11.5, marginTop: 16, lineHeight: 1.55, maxWidth: 740 }}>
              {r.data.basis}
            </div>
            <div className="m3" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.55, maxWidth: 740 }}>
              The agent was never told about this thesis. It runs its own mandate and its decisions
              are taken without any knowledge that something was riding on them — binding a claim to
              an agent measures it, it does not steer it.
            </div>
          </div>
        </>
      )}

      <Footer />
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 160px) minmax(0, 1fr)',
        gap: 16,
        padding: '10px 16px',
        borderBottom: '1px solid var(--color-divider)',
      }}
    >
      <div className="m3" style={{ fontSize: 11.5 }}>
        {label}
      </div>
      <div className={mono ? 'mono' : undefined} style={{ fontSize: 12.5 }}>
        {value}
      </div>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'dn' }) {
  return (
    <div style={{ padding: '12px 16px', borderRight: '1px solid var(--color-divider)' }}>
      <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className={`mono ${tone ?? ''}`} style={{ fontSize: 19, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

