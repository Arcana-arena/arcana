/**
 * Evolution — each version, and what changed between them.
 *
 * THE CAVEAT IS NOT FOOTNOTED, IT IS PRINTED AT THE TOP. Versions compete in
 * different periods and therefore in different markets, so "v2 scores higher
 * than v1" is not evidence that the change to the config caused the
 * improvement. A page that puts two scores side by side and stays silent is
 * inviting exactly that conclusion.
 *
 * The deltas come from the endpoint already computed, before/after/change. This
 * page does not subtract anything.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { int, num, utcDate } from '@/lib/format';
import { Key, Lbl, Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import type { EvolutionResponse } from '../shapes';

export async function EvolutionTab({ id }: { id: string }) {
  const r = await agent<EvolutionResponse>(`/v1/agents/${id}/evolution`);
  if (!r.ok) return <Failed what="The evolution record" error={r} />;
  const e = r.data;

  if (!e.versions || e.versions.length <= 1) {
    return (
      <Empty title="This agent has only one version">
        Nothing has been evolved from it and it was not evolved from anything, so there is no before and after to
        compare.
      </Empty>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 26 }}>
      {e.caveat ? (
        <Callout tone="warn">
          <strong>Read the comparison with this in mind.</strong> {e.caveat}
        </Callout>
      ) : null}

      <section>
        <Key>Versions</Key>
        <div className="scroll-x">
          <table className="table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Version</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 180 }}>Window</th>
                <th className="r" style={{ width: 90 }}>
                  Ticks
                </th>
                <th className="r" style={{ width: 100 }}>
                  Decisions
                </th>
                <th className="r" style={{ width: 90 }}>
                  Trades
                </th>
                <th className="r" style={{ width: 110 }}>
                  Turnover
                </th>
                <th className="r" style={{ width: 120 }}>
                  Avg exposure
                </th>
                <th style={{ width: 120 }}>Ranked?</th>
              </tr>
            </thead>
            <tbody>
              {e.versions.map((v) => (
                <tr key={v.agent_id}>
                  <td>
                    <Link href={`/agents/${v.agent_id}`}>v{v.version}</Link>
                  </td>
                  <td>
                    <StatusTag status={v.status} />
                  </td>
                  <td className="mono m3" style={{ fontSize: 11 }}>
                    {v.window ? (
                      <>
                        {utcDate(v.window.first_tick)} → {utcDate(v.window.last_tick)}
                      </>
                    ) : (
                      <span title="No tick window recorded for this version.">no ticks recorded</span>
                    )}
                  </td>
                  <td className="r">
                    <Num value={int(v.activity?.ticks)} />
                  </td>
                  <td className="r">
                    <Num value={int(v.activity?.decisions)} />
                  </td>
                  <td className="r">
                    <Num value={int(v.activity?.trades)} />
                  </td>
                  <td className="r">
                    <Num value={num(v.activity?.turnover, 4)} />
                  </td>
                  <td className="r">
                    <Num value={num(v.activity?.avg_exposure, 4)} />
                  </td>
                  <td>{v.ranked ? <Tag tone="outline">RANKED</Tag> : <Tag tone="dashed">UNRANKED</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(e.comparisons ?? []).map((c) => (
        <section key={`${c.from_version}-${c.to_version}`}>
          <Key>
            v{c.from_version} → v{c.to_version}
          </Key>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,340px) minmax(0,1fr)', gap: 28, marginTop: 10 }}>
            <div>
              <Lbl>CONFIG</Lbl>
              {!c.config_changed?.changed ? (
                <div className="m2" style={{ fontSize: 12.5, marginTop: 4 }}>
                  nothing in the configuration changed between these versions
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                  {Object.entries(c.config_changed.fields ?? {}).map(([field, v]) => (
                    <div key={field} className="node" style={{ fontSize: 12 }}>
                      <span className="mono m2">{field}</span>
                      <div className="mono" style={{ marginTop: 2 }}>
                        {JSON.stringify(v.from)} <span className="m3">→</span> {JSON.stringify(v.to)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {c.behaviour ? (
                <div style={{ marginTop: 14 }}>
                  <Lbl>BEHAVIOUR</Lbl>
                  <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>
                    <Num value={num(c.behaviour.dna_similarity, 4)} />
                  </div>
                  <div className="m2" style={{ fontSize: 12 }}>
                    {c.behaviour.reading ?? 'no reading given'}
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              <Lbl>WHAT MOVED</Lbl>
              <div className="scroll-x">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 180 }}>Measure</th>
                      <th className="r" style={{ width: 120 }}>
                        Before
                      </th>
                      <th className="r" style={{ width: 120 }}>
                        After
                      </th>
                      <th className="r" style={{ width: 120 }}>
                        Change
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(c.deltas ?? {}).map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {k.replace(/_/g, ' ')}
                        </td>
                        <td className="r">
                          <Num value={num(v.before, 4)} />
                        </td>
                        <td className="r">
                          <Num value={num(v.after, 4)} />
                        </td>
                        <td className="r">
                          <Num
                            value={num(v.change, 4)}
                            tone={(v.change ?? 0) > 0 ? 'up' : (v.change ?? 0) < 0 ? 'dn' : 'flat'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
