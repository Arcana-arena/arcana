/**
 * A score, computed again in front of you.
 *
 * WHY THIS PAGE EXISTS. A root on chain for a score proves the number was not
 * edited afterwards; it does not prove the number is what the data gives. This
 * page shows the manifest the scoring engine sealed — formula version, every
 * constant and weight, every input, every output — the same score recomputed
 * by a second implementation with the manifest's own constants, every input
 * checked against the record it names, how much of that input is itself sealed
 * and on chain, and the steps to do all of it without ARCANA.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent, qs } from '@/lib/api';
import { int, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Check = { name: string; ok: boolean; detail?: string };
type Outputs = Record<string, number | boolean | null>;
type Proof = {
  status: 'anchored' | 'anchoring' | 'mismatch' | 'pending';
  note?: string;
  anchor?: { id: number; root: string; tx_hash: string; explorer_url: string | null; block_number: number | null; mined_at: string | null };
  leaf_index?: number;
  leaf_count?: number;
  checks?: Check[];
};

type Verification =
  | {
      agent: { id: string; name: string };
      status: 'not_sealed';
      note: string;
      other_sealed_scores: Array<{ season_id: string; ts: string; arcana_score: string | null }>;
    }
  | {
      agent: { id: string; name: string };
      status: 'verified' | 'mismatch' | 'broken';
      summary?: string;
      seal: string;
      score?: { season_id: string; ts: string; seal: string; seal_scheme: string; stored: Record<string, number | null> };
      formula?: { version: string; url: string };
      outputs?: Outputs;
      recomputed?: Outputs | null;
      working?: Record<string, number | boolean | null> | null;
      coverage?: Array<{ input: string; total: number; sealed: number; anchored: number; unsealed_note: string | null }>;
      checks: Check[];
      anchor?: Proof;
      manifest?: { sha256: string; bytes: number; body: string; parsed?: { constants: Record<string, unknown>; nav_series: Array<Record<string, unknown>>; decisions: unknown[]; creator_peers: unknown[] } };
      how_to_recompute?: string[];
      other_sealed_scores: Array<{ season_id: string; ts: string; arcana_score: string | null }>;
    };

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const OUTPUT_KEYS = ['arcana', 'performance', 'risk', 'consistency', 'strategy', 'regime', 'creator', 'longevity', 'strategy_multiplier', 'ranked'];

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(v) : String(v));

export default async function ScoreVerificationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const r = await agent<Verification>(
    `/v1/agents/${id}/score/verification${qs({ season_id: one(sp.season_id), ts: one(sp.ts) })}`,
  );
  if (!r.ok && r.status === 404) notFound();

  return (
    <div className="page">
      <Header />
      <div className="sec" style={{ paddingTop: 28, paddingBottom: 18, borderBottom: 'none' }}>
        <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
          <Link href={`/agents/${id}`} className="m2">
            {r.ok ? r.data.agent.name : 'Agent'}
          </Link>{' '}
          / Score, recomputed
        </div>
        <h1 style={{ margin: 0 }}>Compute this score yourself</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 780, lineHeight: 1.55 }}>
          A root on chain proves a score was not changed afterwards. It does not prove the score is right. What does is
          being able to compute it again: the inputs are sealed and anchored, the formula and the weights in force are
          written into the score&rsquo;s own manifest, and every step is below.{' '}
          <Link href="/docs/scoring#recompute">How recomputation works</Link>
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="This score's verification" error={r} />
        ) : r.data.status === 'not_sealed' ? (
          <>
            <Callout tone="note">
              <strong>This score cannot be recomputed from a sealed record.</strong> {r.data.note}
            </Callout>
            <OtherScores id={id} rows={r.data.other_sealed_scores} />
          </>
        ) : (
          <Body id={id} v={r.data} />
        )}
      </div>
      <Footer />
    </div>
  );
}

function Body({ id, v }: { id: string; v: Exclude<Verification, { status: 'not_sealed' }> }) {
  const failed = v.checks.filter((c) => !c.ok);
  return (
    <>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <div className="lbl">ARCANA SCORE</div>
          <div className="mono" style={{ fontSize: 30 }}>{show(v.outputs?.arcana)}</div>
        </div>
        <div>
          <div className="lbl">SCORED (UTC)</div>
          <div className="mono">{v.score ? utc(v.score.ts) : '—'}</div>
        </div>
        <div>
          <div className="lbl">FORMULA</div>
          <div className="mono">{v.formula?.version ?? '—'}</div>
        </div>
        <div>
          <div className="lbl">CHECKS</div>
          <div className={`mono ${failed.length === 0 ? 'up' : 'dn'}`}>{v.summary ?? `${failed.length} failed`}</div>
        </div>
      </div>

      {failed.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <Callout tone="bad">
            <strong>{failed.length} check(s) did not pass.</strong> They are listed first below. A failed check is shown, not
            smoothed over: the score is not verified until every one passes.
          </Callout>
        </div>
      ) : null}

      <h2 style={{ fontSize: 16, margin: '20px 0 8px' }}>1. Outputs, recorded and recomputed</h2>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Output</th>
              <th className="r">In the manifest</th>
              <th className="r">Recomputed here</th>
              <th className="r">Stored column</th>
            </tr>
          </thead>
          <tbody>
            {OUTPUT_KEYS.map((k) => {
              const col = `${k}_score`;
              const stored = v.score?.stored?.[col];
              const same = v.recomputed ? v.recomputed[k] === v.outputs?.[k] : null;
              return (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="r mono">{show(v.outputs?.[k])}</td>
                  <td className={`r mono ${same === false ? 'dn' : ''}`}>{v.recomputed ? show(v.recomputed[k]) : '—'}</td>
                  <td className="r mono m2">{stored === undefined ? '' : show(stored)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {v.working ? (
        <details style={{ marginTop: 10 }}>
          <summary className="m2" style={{ fontSize: 12, cursor: 'pointer' }}>Every intermediate value</summary>
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <tbody>
                {Object.entries(v.working).map(([k, val]) => (
                  <tr key={k}>
                    <td className="mono m2">{k}</td>
                    <td className="r mono">{show(val)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <h2 style={{ fontSize: 16, margin: '24px 0 8px' }}>2. The inputs, and how much of them is on chain</h2>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Input</th>
              <th className="r">Used</th>
              <th className="r">Sealed</th>
              <th className="r">In a mined anchor</th>
            </tr>
          </thead>
          <tbody>
            {(v.coverage ?? []).map((c) => (
              <tr key={c.input}>
                <td>{c.input}</td>
                <td className="r mono">{int(c.total)}</td>
                <td className="r mono">{int(c.sealed)}</td>
                <td className="r mono">{int(c.anchored)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(v.coverage ?? []).some((c) => c.unsealed_note) ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone="warn">
            {(v.coverage ?? []).filter((c) => c.unsealed_note).map((c) => (
              <div key={c.input}>{c.unsealed_note}</div>
            ))}
          </Callout>
        </div>
      ) : null}

      <h2 style={{ fontSize: 16, margin: '24px 0 8px' }}>3. Every check</h2>
      <ul style={{ margin: '0 0 0 18px', padding: 0, fontSize: 12.5, lineHeight: 1.7 }}>
        {[...failed, ...v.checks.filter((c) => c.ok)].map((c, i) => (
          <li key={i} className={c.ok ? 'm2' : 'dn'}>
            {c.ok ? '✓' : '✗'} {c.name}
            {c.detail ? <span className="mono m3" style={{ fontSize: 11 }}> — {c.detail}</span> : null}
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 16, margin: '24px 0 8px' }}>4. This score on chain</h2>
      <AnchorSummary proof={v.anchor} />

      <h2 style={{ fontSize: 16, margin: '24px 0 8px' }}>5. Recompute it without ARCANA</h2>
      <ol style={{ margin: '0 0 0 18px', padding: 0, fontSize: 12.5, lineHeight: 1.65 }}>
        {(v.how_to_recompute ?? []).map((s, i) => (
          <li key={i} className="m2">{s}</li>
        ))}
      </ol>
      <div className="m2" style={{ fontSize: 12, marginTop: 8 }}>
        The formula&rsquo;s steps and constants:{' '}
        <code>GET {v.formula?.url}</code> · This verification as data:{' '}
        <code>
          GET /v1/agents/{id}/score/verification?season_id={v.score?.season_id}&amp;ts={v.score?.ts}
        </code>
      </div>

      {v.manifest ? (
        <details style={{ marginTop: 16 }}>
          <summary className="m2" style={{ fontSize: 12, cursor: 'pointer' }}>
            The sealed manifest · {int(v.manifest.bytes)} bytes · sha256 {v.manifest.sha256.slice(0, 16)}…
          </summary>
          <div className="scroll-x" style={{ marginTop: 8 }}>
            <pre className="mono" style={{ fontSize: 10.5, whiteSpace: 'pre', lineHeight: 1.45 }}>{v.manifest.body}</pre>
          </div>
        </details>
      ) : null}

      <OtherScores id={id} rows={v.other_sealed_scores} />
    </>
  );
}

function AnchorSummary({ proof }: { proof?: Proof }) {
  if (!proof) return <div className="m3">No anchor information.</div>;
  if (!proof.anchor) {
    return (
      <div className="m2" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span className="am mono">waiting</span> — {proof.note}
      </div>
    );
  }
  const passed = (proof.checks ?? []).filter((c) => c.ok).length;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 12px', fontSize: 12.5 }}>
      <span className="m3">status</span>
      <span className={`mono ${proof.status === 'anchored' ? 'up' : proof.status === 'mismatch' ? 'dn' : 'am'}`}>
        {proof.status} · {passed} of {(proof.checks ?? []).length} checks pass
      </span>
      <span className="m3">root</span>
      <span className="mono" style={{ wordBreak: 'break-all' }}>{proof.anchor.root}</span>
      <span className="m3">transaction</span>
      <span className="mono" style={{ wordBreak: 'break-all' }}>
        {proof.anchor.explorer_url ? <a href={proof.anchor.explorer_url} target="_blank" rel="noreferrer">{proof.anchor.tx_hash}</a> : proof.anchor.tx_hash}
      </span>
      <span className="m3">position</span>
      <span className="mono">
        leaf {proof.leaf_index} of {proof.leaf_count} in <Link href="/anchors">anchor {proof.anchor.id}</Link>
        {proof.anchor.block_number ? ` · block ${proof.anchor.block_number}` : ''}
      </span>
    </div>
  );
}

function OtherScores({ id, rows }: { id: string; rows: Array<{ season_id: string; ts: string; arcana_score: string | null }> }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ marginTop: 22 }}>
      <div className="lbl" style={{ marginBottom: 6 }}>OTHER SEALED SCORES OF THIS AGENT</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
        {rows.map((s) => (
          <Link key={`${s.season_id}-${s.ts}`} className="mono" href={`/agents/${id}/score${qs({ season_id: s.season_id, ts: s.ts })}`}>
            {utc(s.ts)} · {s.arcana_score ?? 'unranked'}
          </Link>
        ))}
      </div>
    </div>
  );
}
