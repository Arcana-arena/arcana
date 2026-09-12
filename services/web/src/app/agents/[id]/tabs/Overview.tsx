/**
 * Overview — the score, the money, and who decided the trades.
 *
 * THE SCORE BREAKDOWN IS READ, NOT RECOMPUTED. The seven components come from
 * the latest score snapshot exactly as the scoring engine wrote them. This page
 * does not weight them, does not sum them, and does not check that they add up
 * to the composite: that arithmetic belongs to score.go, and doing it a second
 * time here would produce a number that is right until the day the weights
 * change and nobody remembers this file exists.
 *
 * REGIME IS PRINTED AS A PLACEHOLDER, NOT AS A MEASUREMENT. The classifier is
 * not implemented and every agent carries the same neutral value, so a bar next
 * to the other six would read as "this agent scores well on regime" when in
 * fact nothing has been measured at all.
 *
 * THE NAV CHART DRAWS THE POINTS THE BACKEND SENT. The series is already
 * bucketed server-side, keeping the first, last, min and max of each bucket —
 * the minima ARE the drawdowns — so there is no resampling here.
 */
import { agent } from '@/lib/api';
import { int, money, score as fmtScore, utc } from '@/lib/format';
import { Key, Lbl, Num, ScoreBar } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import type { Err } from '@/lib/api';
import type { NavSeries, Passport } from '../shapes';

const COMPONENTS: Array<{ key: string; label: string }> = [
  { key: 'performance_score', label: 'Performance' },
  { key: 'risk_score', label: 'Risk' },
  { key: 'consistency_score', label: 'Consistency' },
  { key: 'longevity_score', label: 'Longevity' },
  { key: 'strategy_score', label: 'Strategy' },
  { key: 'creator_score', label: 'Creator' },
];

export async function OverviewTab({
  id,
  p,
  passportError,
}: {
  id: string;
  p: Passport | null;
  passportError: Err | null;
}) {
  const navR = await agent<NavSeries>(`/v1/agents/${id}/series/nav?page_size=500`);

  const latest = p?.score_history?.latest ?? null;
  const peak = p?.score_history?.peak ?? null;
  const first = p?.score_history?.first ?? null;

  return (
    <div style={{ display: 'grid', gap: 28 }}>
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 420px) minmax(0, 1fr)', gap: 32 }}>
        <div>
          <Key>ARCANA Score</Key>
          {passportError ? (
            <Failed what="The score" error={passportError} />
          ) : !latest ? (
            <Empty title="No score snapshot exists yet">
              The scoring engine has not written a snapshot for this agent. There is no score to show — which is
              different from a score of zero.
            </Empty>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, margin: '10px 0 20px' }}>
                <div>
                  <div className="mono" style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
                    {latest.arcana_score === null ? (
                      <span
                        className="m3"
                        style={{ fontSize: 22 }}
                        title="The scoring engine wrote NULL into the composite because this agent has not competed enough. It is withheld, not low."
                      >
                        withheld
                      </span>
                    ) : (
                      fmtScore(latest.arcana_score)
                    )}
                  </div>
                  <Lbl>LATEST · {utc(latest.ts)}</Lbl>
                </div>
                <div style={{ paddingBottom: 4 }}>
                  <Lbl>PEAK</Lbl>
                  <div className="mono" style={{ fontSize: 20 }}>
                    {peak ? fmtScore(peak.arcana_score) : '—'}
                  </div>
                  <div className="mono m3" style={{ fontSize: 10.5 }}>
                    {peak ? utc(peak.ts) : 'no peak recorded'}
                  </div>
                </div>
                <div style={{ paddingBottom: 4 }}>
                  <Lbl>FIRST</Lbl>
                  <div className="mono" style={{ fontSize: 20 }}>
                    {first ? fmtScore(first.arcana_score) : '—'}
                  </div>
                </div>
              </div>

              <Key>Components · as the engine wrote them</Key>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '92px minmax(0,1fr) 44px',
                  gap: '8px 10px',
                  alignItems: 'center',
                  fontSize: 12,
                  marginTop: 10,
                }}
              >
                {COMPONENTS.map((c) => {
                  const v = latest[c.key] as number | null | undefined;
                  return (
                    <div key={c.key} style={{ display: 'contents' }}>
                      <span>{c.label}</span>
                      <ScoreBar value={typeof v === 'number' ? v : null} />
                      <span className="r">
                        <Num value={fmtScore(v)} />
                      </span>
                    </div>
                  );
                })}
                <span className="m3">Regime</span>
                <div
                  className="bar"
                  style={{ background: 'transparent', border: '1px dashed var(--ink-4)' }}
                  title="No bar is drawn: the market-regime classifier is not implemented and every agent carries the same placeholder."
                />
                <span className="r m3" style={{ fontSize: 10.5 }}>
                  n/a
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <Callout tone="warn">
                  <strong>Regime is not measured.</strong> The classifier is not implemented; the scoring engine writes
                  the same neutral placeholder for every agent, so there is nothing here that distinguishes this agent
                  from any other.
                </Callout>
              </div>
            </>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <Key>NAV · the book, as recorded</Key>
            {navR.ok ? (
              <span className="mono m3" style={{ fontSize: 10.5 }}>
                {navR.data.total_points} of {navR.data.stored_points} stored points
              </span>
            ) : null}
          </div>
          {!navR.ok ? (
            <Failed what="The NAV series" error={navR} />
          ) : navR.data.points.length === 0 ? (
            <Empty title="No NAV points recorded">
              This agent has no NAV snapshots in the requested range. The chart is absent rather than flat — a flat
              line would claim the book did not move.
            </Empty>
          ) : (
            <>
              <LineChart
                height={220}
                unit="USDG"
                points={navR.data.points.map((pt) => ({
                  ts: pt.ts,
                  value: typeof pt.nav === 'number' ? pt.nav : null,
                  agg: pt.agg ?? null,
                  season_id: pt.season_id,
                }))}
                baseline={navR.data.points[0]?.nav ?? null}
                baselineLabel={`first recorded ${money(navR.data.points[0]?.nav ?? null)}`}
                resolutionNote={navR.data.resolution?.reason ?? null}
              />
              {navR.data.resolution?.mode !== 'raw' ? (
                <div style={{ marginTop: 10 }}>
                  <Callout tone="note">
                    <strong>This series is bucketed by the backend.</strong> Each bucket keeps its first, last,
                    minimum and maximum — so the extremes, including every drawdown low, survive. The browser does not
                    thin it further.
                  </Callout>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      <DecidedBy p={p} />

      <Career p={p} />
    </div>
  );
}

/**
 * Who decided the trades.
 *
 * A protective exit is the PLATFORM acting on a level, not the agent making a
 * call. Folding the two into one "trades" number credits an agent with the work
 * its stop loss did. The three columns here are never summed into one.
 *
 * `unattributed` is its own column too: those rows predate the `decider`
 * distinction and genuinely do not say who acted. Putting them in the agent's
 * column would overstate what is known.
 */
function DecidedBy({ p }: { p: Passport | null }) {
  const d = p?.decided_by;
  if (!d) {
    return (
      <section>
        <Key>Who decided</Key>
        <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
          the passport carried no decided_by block, so the agent&rsquo;s own trades cannot be separated from
          protective exits here
        </div>
      </section>
    );
  }
  return (
    <section>
      <Key>Who decided · the agent, or a level</Key>
      <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
        <div className="stat-cell">
          <Lbl>THE AGENT&rsquo;S OWN TRADES</Lbl>
          <div className="stat-value">
            <Num value={int(d.own)} />
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>PROTECTIVE EXITS</Lbl>
          <div className="stat-value">
            <Num value={int(d.protective)} tone={d.protective ? 'am' : 'flat'} />
          </div>
          <div className="stat-sub">decided by a level, not by the agent</div>
        </div>
        <div className="stat-cell">
          <Lbl>OF WHICH STOP / TARGET</Lbl>
          <div className="stat-value" style={{ fontSize: 20 }}>
            <Num value={int(d.stop_loss)} /> <span className="m3">/</span> <Num value={int(d.take_profit)} />
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>UNATTRIBUTED</Lbl>
          <div className="stat-value">
            <Num value={int(d.unattributed)} />
          </div>
          <div className="stat-sub">rows that predate the distinction</div>
        </div>
      </div>
      {d.note ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone="note">{d.note}</Callout>
        </div>
      ) : null}
    </section>
  );
}

function Career({ p }: { p: Passport | null }) {
  const c = p?.career;
  const part = p?.participation;
  if (!c) return null;
  return (
    <section>
      <Key>Career</Key>
      <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
        <div className="stat-cell">
          <Lbl>TICKS RECORDED</Lbl>
          <div className="stat-value">
            <Num value={int(c.total_ticks)} />
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>DECISIONS</Lbl>
          <div className="stat-value">
            <Num value={int(c.total_decisions)} />
          </div>
          <div className="stat-sub">
            {part?.threshold_decisions ? `${int(part.threshold_decisions)} needed to be ranked` : ''}
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>TRADES</Lbl>
          <div className="stat-value">
            <Num value={int(c.total_trades)} />
          </div>
          <div className="stat-sub">holds are decisions, not trades</div>
        </div>
        <div className="stat-cell">
          <Lbl>SEASONS ENTERED</Lbl>
          <div className="stat-value">
            <Num value={int(c.seasons_entered)} />
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>FIRST TICK</Lbl>
          <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>
            {utc(c.first_tick)}
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>LAST TICK</Lbl>
          <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>
            {utc(c.last_tick)}
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>BADGES</Lbl>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {(p?.badges ?? []).length === 0 ? (
              <span className="m3" style={{ fontSize: 11.5 }}>
                none earned
              </span>
            ) : (
              (p?.badges ?? []).map((b) => (
                <span key={b.code} className="tag tag-outline" title={b.criterion}>
                  {b.label}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="stat-cell">
          <Lbl>STATUS IN SEASON</Lbl>
          <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>
            {part?.status ?? '—'}
          </div>
        </div>
      </div>
    </section>
  );
}

