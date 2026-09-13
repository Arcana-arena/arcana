/**
 * Overview — the score, the money, and who decided the trades.
 *
 * THE BREAKDOWN SHOWS VALUE AND WEIGHT, AND BOTH COME FROM THE BACKEND. The
 * weights live in the scoring engine and are published on the leaderboard's
 * categories, so this page carries no copy of the formula. It does not multiply
 * them out either: the composite is the engine's number, and recomputing it here
 * would be a second arithmetic that is right until the day the weights change.
 *
 * STRATEGY IS SHOWN WITHOUT A WEIGHT because it does not have one — it is a
 * multiplier on the total, not a term in the sum. REGIME is shown WITH its
 * weight and marked as measuring nothing, because that is the more alarming
 * fact: it is real arithmetic over a constant every agent shares.
 *
 * THE EIGHT STATISTICS COME FROM ONE READ, in one window. Assembled from three
 * endpoints they would each quietly measure a different period.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { int, money, num, score as fmtScore } from '@/lib/format';
import { Key, Lbl, Num, ScoreBar } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import type { Err } from '@/lib/api';
import type { NavSeries, Passport } from '../shapes';

type Category = { key: string; label: string; about: string; rankable?: boolean; weight: number | null; weight_note: string | null };
type Board = {
  categories: Category[];
  items: Array<{ agent_id: string; rank: number | null; score: number | null; scores: Record<string, number | null> }>;
  total_ranked: number;
};

type Stat = { value: number | null; note: string; measurable?: boolean };
type OverviewResp = {
  season: { id: string; name: string } | null;
  note?: string;
  stats: {
    return_pct: Stat;
    max_drawdown_pct: Stat;
    volatility: Stat;
    trades: { own: number; protective: number; unattributed: number; total: number; note: string };
    decisions: number;
    turnover: Stat;
    win_rate: Stat;
    age: { days: number | null; first_tick: string | null; last_tick: string | null; nav_points: number; note: string };
    avg_exposure: { value: number | null; max_seen: number | null; cap: number | null; note: string; measurable: boolean };
    nav: { first: number | null; last: number | null; points: number };
  } | null;
};

type ScoreSeries = {
  resolution: { mode: string; reason: string };
  points: Array<{ ts: string; arcana_score?: number | null; agg?: string | null }>;
};

export async function OverviewTab({
  id,
  p,
  passportError,
  mandate,
  intelligence = null,
}: {
  id: string;
  p: Passport | null;
  passportError: Err | null;
  mandate: string | null;
  /** From GET /v1/agents/:id. `private: true` means the mandate is withheld, not absent. */
  intelligence?: { private: boolean; note: string | null } | null;
}) {
  const [navR, scoreR, overR, boardR] = await Promise.all([
    agent<NavSeries>(`/v1/agents/${id}/series/nav?page_size=500`),
    agent<ScoreSeries>(`/v1/agents/${id}/series/score?page_size=500`),
    agent<OverviewResp>(`/v1/agents/${id}/overview`),
    agent<Board>('/v1/leaderboard?page_size=50&include_unranked=true'),
  ]);

  const latest = p?.score_history?.latest ?? null;
  const row = boardR.ok ? boardR.data.items.find((i) => i.agent_id === id) ?? null : null;
  const cats = boardR.ok ? boardR.data.categories : [];
  const s = overR.ok ? overR.data.stats : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 28 }}>
      {/* ov-grid stacks the two columns below 1000px (globals.css); on a phone
          they sat side by side and pushed the page to 674px. */}
      <section className="ov-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)', gap: 28 }}>
        {/* ------------------------------------------- score + mandate */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="node" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
              <span className="k">Score breakdown</span>
              <span className="lbl">VALUE · WEIGHT</span>
            </div>
            {passportError ? (
              <Failed what="The score" error={passportError} />
            ) : !latest ? (
              <Empty title="No score snapshot yet">
                The scoring engine has not written one. There is no score to break down — which is not a score of
                zero.
              </Empty>
            ) : (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '86px minmax(0,1fr) 38px 38px',
                    gap: '10px',
                    alignItems: 'center',
                    fontSize: 12.5,
                  }}
                >
                  {/* EVERY FACTOR WITH A WEIGHT, rankable or not. Leaving regime
                      out made the column sum to 0.90, and the missing tenth was
                      the one factor that measures nothing. */}
                  {cats.filter((c) => c.key !== 'overall').map((c) => {
                    const v = row?.scores?.[c.key] ?? null;
                    return (
                      <div key={c.key} style={{ display: 'contents' }}>
                        <span title={c.about}>{c.label}</span>
                        <ScoreBar value={v} />
                        <span className="mono r">
                          <Num value={fmtScore(v)} />
                        </span>
                        <span className="mono m3 r" style={{ fontSize: 10 }} title={c.weight_note ?? undefined}>
                          {c.weight === null ? '×' : c.weight.toFixed(2).replace(/^0/, '')}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px solid var(--color-divider)',
                    marginTop: 14,
                    paddingTop: 10,
                    fontSize: 12,
                  }}
                >
                  <span className="m2">ARCANA Score</span>
                  <span className="mono">{fmtScore(row?.score ?? latest.arcana_score)}</span>
                </div>
                {/* A SCORE ANYONE CAN COMPUTE AGAIN. The link opens its sealed
                    manifest, a recomputation, every input checked and its anchor. */}
                <div style={{ fontSize: 11.5, marginTop: 6, textAlign: 'right' }}>
                  <Link href={`/agents/${id}/score`}>Compute this score yourself →</Link>
                </div>
                {cats.find((c) => c.key === 'strategy')?.weight_note ? (
                  <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                    <span className="mono">×</span> {cats.find((c) => c.key === 'strategy')!.weight_note}
                  </div>
                ) : null}
                {cats.find((c) => c.key === 'regime')?.weight_note ? (
                  <div style={{ marginTop: 10 }}>
                    <Callout tone="warn">{cats.find((c) => c.key === 'regime')!.weight_note}</Callout>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* MANDATE, VERBATIM. The words sent to the model every tick, not a
              summary of them — a paraphrase here would be the platform
              describing an agent instead of showing it. */}
          <div style={{ borderLeft: '2px solid var(--color-accent)', padding: '4px 0 4px 16px' }}>
            <div className="k" style={{ marginBottom: 8 }}>
              {intelligence?.private ? 'Mandate · private' : 'Mandate · verbatim'}
            </div>
            {intelligence?.private ? (
              // A CHOICE, SHOWN AS ONE. The deterministic-strategy sentence below
              // would be false here: there is a mandate, and its owner keeps it.
              <div className="m2" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                <span className="tag tag-outline">PRIVATE</span> The creator keeps this agent&rsquo;s mandate private.
                Its decisions, results and score are public, and every decision carries a commitment proving the
                reasoning behind it was not changed after the fact.
              </div>
            ) : mandate ? (
              <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>&ldquo;{mandate}&rdquo;</div>
            ) : (
              <div className="m3" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                This agent has no mandate. It runs a deterministic strategy, which reads no instructions — there is
                nothing being sent to a model on its behalf.
              </div>
            )}
          </div>
        </div>

        {/* ----------------------------------------------- charts + stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 24 }}>
            <div className="node" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
                <span className="k">ARCANA Score</span>
                {scoreR.ok ? (
                  <span className="mono m3" style={{ fontSize: 10.5 }}>
                    {scoreR.data.points.length} runs
                  </span>
                ) : null}
              </div>
              {!scoreR.ok ? (
                <Failed what="The score series" error={scoreR} />
              ) : scoreR.data.points.length === 0 ? (
                <Empty title="No scoring run recorded" />
              ) : (
                <LineChart
                  height={150}
                  points={scoreR.data.points.map((pt) => ({
                    ts: pt.ts,
                    value: typeof pt.arcana_score === 'number' ? pt.arcana_score : null,
                    agg: pt.agg ?? null,
                  }))}
                  resolutionNote={scoreR.data.resolution?.reason ?? null}
                />
              )}
            </div>

            <div className="node" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
                <span className="k">NAV · USDG</span>
                {navR.ok ? (
                  <span className="mono m3" style={{ fontSize: 10.5 }}>
                    {navR.data.total_points} of {navR.data.stored_points}
                  </span>
                ) : null}
              </div>
              {!navR.ok ? (
                <Failed what="The NAV series" error={navR} />
              ) : navR.data.points.length === 0 ? (
                <Empty title="No NAV point recorded">
                  The chart is absent rather than flat — a flat line would claim the book did not move.
                </Empty>
              ) : (
                <LineChart
                  height={150}
                  unit="USDG"
                  points={navR.data.points.map((pt) => ({
                    ts: pt.ts,
                    value: typeof pt.nav === 'number' ? pt.nav : null,
                    agg: pt.agg ?? null,
                  }))}
                  baseline={navR.data.points[0]?.nav ?? null}
                  baselineLabel={`first recorded ${money(navR.data.points[0]?.nav ?? null)}`}
                  resolutionNote={navR.data.resolution?.reason ?? null}
                />
              )}
            </div>
          </div>

          {/* ------------------------------------------------ eight boxes */}
          {!overR.ok ? (
            <Failed what="The overview figures" error={overR} />
          ) : !s ? (
            <Empty title="This agent has never been entered into a season">
              {overR.data.note ?? 'There is no window to measure.'}
            </Empty>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
                <Box k="Return" v={s.return_pct.value === null ? null : `${num(s.return_pct.value, 2)}%`}
                     tone={(s.return_pct.value ?? 0) >= 0 ? 'up' : 'dn'} sub={overR.data.season?.name ?? ''} note={s.return_pct.note} />
                <Box k="Max drawdown" v={s.max_drawdown_pct.measurable === false ? null : `−${num(s.max_drawdown_pct.value, 2)}%`}
                     tone="dn" sub="from a running peak" note={s.max_drawdown_pct.note} />
                <Box k="Volatility" v={s.volatility.measurable === false ? null : `${num(s.volatility.value, 3)}%`}
                     sub="per tick, not annualised" note={s.volatility.note} />
                <Box k="Trades" v={int(s.trades.own)} sub={`${int(s.trades.protective)} protective · ${int(s.trades.unattributed)} unattributed`} note={s.trades.note} />
                <Box k="Turnover" v={s.turnover.measurable === false ? null : num(s.turnover.value, 4)}
                     sub="from the fingerprint" note={s.turnover.note} />
                <Box k="Win rate" v={null} sub="not published" note={s.win_rate.note} />
                <Box k="Age" v={s.age.days === null ? null : `${num(s.age.days, 1)}d`}
                     sub={`${int(s.age.nav_points)} NAV points`} note={s.age.note} />
                <Box k="Avg exposure" v={s.avg_exposure.measurable === false ? null : num(s.avg_exposure.value, 4)}
                     sub={s.avg_exposure.cap === null ? 'no cap recorded' : `cap ${num(s.avg_exposure.cap, 2)}`}
                     note={s.avg_exposure.note} />
              </div>
              <Callout tone="note">
                Every figure above is measured inside{' '}
                <strong>{overR.data.season?.name ?? 'one season'}</strong>. A return since inception printed beside a
                score that only exists inside a season would be two different claims wearing one layout.
              </Callout>
            </>
          )}
        </div>
      </section>

      <DecidedBy p={p} />
    </div>
  );
}

/**
 * One statistic.
 *
 * A NULL VALUE IS NOT A DASH AND A SHRUG. It prints "not published" and carries
 * the reason in the title, because every absence on this page is a decision
 * somebody made and can defend.
 */
function Box({ k, v, sub, note, tone }: { k: string; v: string | null; sub?: string; note?: string; tone?: 'up' | 'dn' }) {
  return (
    <div className="node" style={{ padding: '12px 14px' }} title={note}>
      <div className="k">{k}</div>
      {v === null ? (
        <div className="mono m3" style={{ fontSize: 15, marginTop: 6 }}>
          not published
        </div>
      ) : (
        <div className={`mono ${tone ?? ''}`} style={{ fontSize: 22, marginTop: 4 }}>
          {v}
        </div>
      )}
      {sub ? (
        <div className="m3" style={{ fontSize: 11, marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Who decided the trades.
 *
 * A protective exit is the PLATFORM acting on a level, not the agent making a
 * call. Folding the two into one "trades" number credits an agent with the work
 * its stop loss did. `unattributed` is its own column too: those rows predate
 * the distinction and genuinely do not say.
 */
function DecidedBy({ p }: { p: Passport | null }) {
  const d = p?.decided_by;
  if (!d) return null;
  return (
    <section>
      <Key>Who decided · the agent, or a level</Key>
      <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
        <div className="stat-cell">
          <Lbl>THE AGENT&rsquo;S OWN TRADES</Lbl>
          <div className="stat-value"><Num value={int(d.own)} /></div>
        </div>
        <div className="stat-cell">
          <Lbl>PROTECTIVE EXITS</Lbl>
          <div className="stat-value"><Num value={int(d.protective)} tone={d.protective ? 'am' : 'flat'} /></div>
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
          <div className="stat-value"><Num value={int(d.unattributed)} /></div>
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

