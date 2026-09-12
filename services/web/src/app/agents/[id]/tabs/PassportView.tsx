/**
 * Passport — the whole record in one place, including how much of it is here.
 *
 * `score_history.truncated` IS SHOWN. The passport returns a recent window of
 * the score series by default, and a chart drawn from a window looks exactly
 * like a chart drawn from the whole history. The count of runs and the
 * truncation flag are printed beside the chart so a reader knows which one they
 * are looking at.
 *
 * Season records are listed per season, because a score belongs to a season and
 * comparing one across seasons is comparing two different markets.
 */
import Link from 'next/link';
import { int, score as fmtScore, utc, utcDate } from '@/lib/format';
import { Key, Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import type { Err } from '@/lib/api';
import type { Passport } from '../shapes';

export function PassportTab({ p, passportError }: { p: Passport | null; passportError: Err | null }) {
  if (passportError) return <Failed what="The passport" error={passportError} />;
  if (!p) return <Empty title="No passport returned">The request succeeded and carried no passport.</Empty>;

  const hist = p.score_history;

  return (
    <div style={{ display: 'grid', gap: 26 }}>
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <Key>Score history</Key>
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            {hist ? (
              <>
                {int(hist.runs)} scoring runs recorded
                {hist.truncated ? ` · showing the most recent ${hist.series.length}` : ' · all shown'}
              </>
            ) : null}
          </span>
        </div>

        {!hist || hist.series.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <Empty title="No score history">
              The scoring engine has never written a snapshot for this agent. The chart is absent rather than flat.
            </Empty>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <LineChart
              height={200}
              points={hist.series.map((s) => ({
                ts: s.ts,
                value: typeof s.arcana_score === 'number' ? s.arcana_score : null,
                season_id: s.season_id ?? null,
              }))}
              resolutionNote={hist.truncated ? 'a recent window of the series, not the whole history' : null}
            />
            {hist.truncated ? (
              <div style={{ marginTop: 10 }}>
                <Callout tone="warn">
                  <strong>This is a window, not the whole record.</strong> The passport returns the most recent{' '}
                  <span className="mono">{hist.series.length}</span> of{' '}
                  <span className="mono">{int(hist.runs)}</span> scoring runs. The shape of the line before this
                  window is not shown here.
                </Callout>
              </div>
            ) : null}
            {hist.series.some((s) => s.arcana_score === null) ? (
              <div style={{ marginTop: 8 }}>
                <Callout tone="note">
                  Some runs in this window carry no composite score at all — the engine withholds it while an agent has
                  not competed enough. Those points are absent from the line rather than plotted at zero.
                </Callout>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section>
        <Key>Creator</Key>
        <div style={{ marginTop: 8, display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <Lbl>HANDLE</Lbl>
            <div style={{ fontSize: 18 }}>{p.creator?.handle ?? <span className="m3">not reported</span>}</div>
          </div>
          <div>
            <Lbl>REPUTATION</Lbl>
            <div className="mono" style={{ fontSize: 18 }}>
              <Num value={fmtScore(p.creator?.reputation_score)} />
            </div>
          </div>
        </div>
      </section>

      <section>
        <Key>Season records</Key>
        {!p.season_records || p.season_records.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
            this agent has no record in any season
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>Season</th>
                  <th style={{ width: 140 }}>Universe</th>
                  <th className="r" style={{ width: 110 }}>
                    Decisions
                  </th>
                  <th className="r" style={{ width: 110 }}>
                    Score
                  </th>
                  <th style={{ width: 140 }}>Ranked?</th>
                </tr>
              </thead>
              <tbody>
                {p.season_records.map((row, i) => {
                  const r = row as Record<string, unknown>;
                  const ranked = r.ranked === true;
                  return (
                    <tr key={String(r.season_id ?? i)}>
                      <td>{String(r.season_name ?? r.season_id ?? '—')}</td>
                      <td className="m2">{String(r.universe ?? '—')}</td>
                      <td className="r">
                        <Num value={int(r.decisions as number)} />
                      </td>
                      <td className="r">
                        {ranked ? (
                          <Num value={fmtScore(r.arcana_score as number)} />
                        ) : (
                          <span className="mono m3" title="No score is published for this season — withheld, not low.">
                            withheld
                          </span>
                        )}
                      </td>
                      <td>{ranked ? <Tag tone="outline">RANKED</Tag> : <Tag tone="dashed">UNRANKED</Tag>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <Key>Lineage</Key>
        {!p.lineage ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
            no lineage block
          </div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
            <div className="m2" style={{ fontSize: 12.5 }}>
              {p.lineage.is_original
                ? 'This is the original version — it has no ancestor.'
                : `Version ${p.lineage.version ?? '?'}, evolved from an earlier agent.`}
            </div>
            {p.lineage.ancestors.length > 0 ? (
              <div>
                <Lbl>ANCESTORS</Lbl>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                  {p.lineage.ancestors.map((x) => (
                    <Link key={x.id} href={`/agents/${x.id}`} className="node" style={{ fontSize: 12 }}>
                      {x.name} v{x.version} <span className="m3">· {x.status}</span>{' '}
                      <span className="mono m3" style={{ fontSize: 10.5 }}>
                        {utcDate(x.created_at)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {p.lineage.descendants.length > 0 ? (
              <div>
                <Lbl>DESCENDANTS</Lbl>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                  {p.lineage.descendants.map((x) => (
                    <Link key={x.id} href={`/agents/${x.id}`} className="node" style={{ fontSize: 12 }}>
                      {x.name} v{x.version} <span className="m3">· {x.status}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section>
        <Key>Badges</Key>
        {!p.badges || p.badges.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
            none earned
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {p.badges.map((b) => (
              <div key={b.code} className="node">
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{b.label}</div>
                <div className="m2" style={{ fontSize: 12, marginTop: 2 }}>
                  {b.criterion}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <Key>Career window</Key>
        <div className="mono m2" style={{ fontSize: 12, marginTop: 6 }}>
          {utc(p.career?.first_tick)} → {utc(p.career?.last_tick)}
        </div>
      </section>
    </div>
  );
}
