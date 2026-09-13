/**
 * DNA — what the agent actually does, measured from its own record.
 *
 * The fingerprint is a behavioural vector computed by a batch job, not a claim
 * the agent makes about itself. The declared strategy type sits beside it on
 * purpose: "declared mean_reversion, nearest neighbour is a momentum agent" is
 * exactly the kind of disagreement this page exists to show, and hiding it
 * behind one label would defeat the point.
 *
 * SIMILARITY IS THE BACKEND'S. The neighbour list arrives ordered; it is
 * printed in that order. Nothing here re-scores or re-ranks it.
 *
 * `features_used` IS PRINTED BESIDE `dimensions`. A fingerprint over 9 of 256
 * dimensions is a much weaker statement than one over 256, and a reader who
 * only sees "256-dimensional" would not know that.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { frac, num, utc } from '@/lib/format';
import { Key, Lbl, Num } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import type { DnaResponse, SimilarResponse } from '../shapes';

export async function DnaTab({ id }: { id: string }) {
  const [dnaR, simR] = await Promise.all([
    agent<DnaResponse>(`/v1/agents/${id}/dna`),
    agent<SimilarResponse>(`/v1/agents/${id}/dna/similar`),
  ]);

  if (!dnaR.ok) return <Failed what="The DNA fingerprint" error={dnaR} />;
  const d = dnaR.data;

  if (!d.fingerprint) {
    return (
      <Empty title="No fingerprint has been computed for this agent">
        The DNA batch has not run over this agent&rsquo;s record yet. There is nothing to show — which is not the same
        as a fingerprint of zeroes.
      </Empty>
    );
  }

  const fp = d.fingerprint;
  const features = Object.entries(fp.features ?? {});

  return (
    <div style={{ display: 'grid', gap: 26 }}>
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <Key>Fingerprint</Key>
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            {fp.features_used} of {fp.dimensions} dimensions carry a value · computed {utc(d.computed_at)}
          </span>
        </div>

        {fp.summary?.length ? (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {fp.summary.map((s, i) => (
              <span key={i} className="tag tag-neutral" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'normal', maxWidth: '100%' }}>
                {s}
              </span>
            ))}
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          <Callout tone="note">
            <strong>Declared strategy: {d.declared_strategy_type ?? 'not stated'}.</strong> The fingerprint below is
            measured from what the agent did, not from what it says it is. Where the two disagree, the measurement is
            the evidence and the label is the claim.
          </Callout>
        </div>

        <div className="scroll-x" style={{ marginTop: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 220 }}>Feature</th>
                <th className="r" style={{ width: 140 }}>
                  Value
                </th>
                <th>Scale</th>
              </tr>
            </thead>
            <tbody>
              {features.map(([k, v]) => (
                <tr key={k}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {k}
                  </td>
                  <td className="r">
                    <Num value={frac(v, 6)} />
                  </td>
                  <td>
                    {typeof v === 'number' && Number.isFinite(v) ? (
                      <div className="bar" style={{ maxWidth: 260 }}>
                        <div style={{ width: `${Math.max(0, Math.min(100, v * 100))}%` }} />
                      </div>
                    ) : (
                      <span className="m3" style={{ fontSize: 11.5 }}>
                        no value — nothing is drawn rather than a bar of zero
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.risk_personality ? (
        <section>
          <Key>Risk personality</Key>
          <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
            {Object.entries(d.risk_personality).map(([k, v]) => (
              <div className="stat-cell" key={k}>
                <Lbl>{k.replace(/_/g, ' ')}</Lbl>
                <div className="stat-value" style={{ fontSize: 19 }}>
                  <Num value={frac(v, 4)} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {d.regime_strengths ? (
        <section>
          <Key>Behaviour by market regime</Key>
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Regime</th>
                  <th className="r" style={{ width: 100 }}>
                    Ticks
                  </th>
                  <th className="r" style={{ width: 160 }}>
                    Agent return %
                  </th>
                  <th className="r" style={{ width: 160 }}>
                    Market return %
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.regime_strengths).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="r">
                      <Num value={num(v.ticks, 0)} />
                    </td>
                    <td className="r">
                      {v.ticks === 0 ? (
                        <span className="mono m3" title="No tick was classified into this regime, so there is nothing to average.">
                          no ticks
                        </span>
                      ) : (
                        <Num value={num(v.agent_return_pct, 4)} />
                      )}
                    </td>
                    <td className="r">
                      {v.ticks === 0 ? (
                        <span className="mono m3">no ticks</span>
                      ) : (
                        <Num value={num(v.market_return_pct, 4)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10 }}>
            <Callout tone="note">
              These buckets come from the DNA batch and are a count of ticks, not a judgement. They are unrelated to
              the <span className="mono">regime_score</span> the leaderboard refuses to offer — that one is an
              unimplemented classifier writing the same placeholder for everybody.
            </Callout>
          </div>
        </section>
      ) : null}

      <section>
        <Key>Nearest behaviour, across the platform</Key>
        {!simR.ok ? (
          <div style={{ marginTop: 8 }}>
            <Failed what="The neighbour list" error={simR} />
          </div>
        ) : simR.data.neighbours.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <Empty title="No neighbours found">
              No other agent has a computed fingerprint to compare against, so this is an absence of comparisons, not
              a finding that this agent is unique.
            </Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 240 }}>Agent</th>
                  <th style={{ width: 180 }}>Declares itself</th>
                  <th className="r" style={{ width: 120 }}>
                    Similarity
                  </th>
                  <th>How close</th>
                </tr>
              </thead>
              <tbody>
                {simR.data.neighbours.map((n) => (
                  <tr key={n.agent_id}>
                    <td>
                      <Link href={`/agents/${n.agent_id}`}>{n.agent_name}</Link>
                    </td>
                    <td className="m2">{n.declared_strategy_type ?? '—'}</td>
                    <td className="r">
                      <Num value={frac(n.similarity, 4)} />
                    </td>
                    <td>
                      <div className="bar" style={{ maxWidth: 260 }}>
                        <div style={{ width: `${Math.max(0, Math.min(100, n.similarity * 100))}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
