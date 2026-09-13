/**
 * One season: who is winning, what the rules are, and whether it has been running.
 *
 * THE RULES PANEL IS THE POINT OF THIS PAGE. It lists every rule this
 * competition would be run under, and it marks the ones nothing enforces —
 * there is no days-live threshold, no NAV floor, no per-creator cap and no
 * prize pool on this platform. Omitting those rows would make a short list read
 * as a complete one; giving them plausible figures would state rules that will
 * not turn anybody away. Each row therefore carries its source, or the fact
 * that it has none.
 *
 * A CLOSED SEASON IS DRAWN AS FROZEN. Its standings are the last thing that
 * happened, not a live board, and the page says so — an ended season whose
 * table looks live invites a reader to refresh it for movement that cannot come.
 *
 * TICK HISTORY ANSWERS WHAT STANDINGS CANNOT: whether the competition ran. Days
 * with no tick are absent from the service's array rather than reported as
 * zero, and the bars here are drawn only for days that exist.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent } from '@/lib/api';
import type { Season } from '@/lib/types';
import { int, num, pct, tone, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Rule = {
  key: string;
  label: string;
  value: string | number | null;
  source: string | null;
  enforced: boolean;
  note: string | null;
};

type RulesResponse = {
  season_id: string;
  season_name: string;
  rules: Rule[];
  encoded: number;
  described_only: number;
  note: string;
};

type TicksResponse = {
  season_id: string;
  competitions: number;
  ticks: number;
  ticks_still_open: number;
  first_tick: string | null;
  last_tick: string | null;
  days_with_ticks: number;
  days_season_open: number | null;
  by_day: Array<{ day: string; ticks: number }>;
  by_day_note: string;
  recent: Array<{
    tick_index: number;
    phase: string;
    market_snapshot_ref: string;
    window_start: string | null;
    window_end: string | null;
    competition_id: string;
    competition_status: string;
  }>;
};

type BoardRow = {
  rank: number | null;
  agent_id: string;
  agent_name: string | null;
  version: number | null;
  status: string | null;
  creator: { id: string; handle: string | null } | null;
  score: number | null;
  ranked: boolean;
  unranked_note: string | null;
  decisions: number;
};

type SeriesRow = {
  agent_id: string;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  age_days: number | null;
};

export default async function SeasonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [seasonR, rulesR, ticksR, boardR, seriesR] = await Promise.all([
    agent<Season>(`/v1/seasons/${id}`),
    agent<RulesResponse>(`/v1/seasons/${id}/rules`),
    agent<TicksResponse>(`/v1/seasons/${id}/ticks`),
    agent<{ items: BoardRow[]; total: number; total_ranked?: number }>(
      `/v1/leaderboard?season_id=${id}&page_size=25&include_unranked=true`,
    ),
    agent<{ items: SeriesRow[] }>(`/v1/leaderboard/series?season_id=${id}&buckets=12`),
  ]);

  if (!seasonR.ok && seasonR.status === 404) notFound();
  if (!seasonR.ok) {
    return (
      <div className="page">
        <Header current="Seasons" />
        <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
          <Failed what="This season" error={seasonR} />
        </div>
        <Footer />
      </div>
    );
  }

  const s = seasonR.data;
  const status = s.progress?.status ?? null;
  const closed = status === 'ended';
  const upcoming = status === 'upcoming';
  const perf = new Map((seriesR.ok ? seriesR.data.items : []).map((r) => [r.agent_id, r]));

  return (
    <div className="page">
      <Header current="Seasons" />

      <div className="sec" style={{ paddingTop: 26, paddingBottom: 18, borderBottom: 'none' }}>
        <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
          <Link href="/seasons" className="m2">
            Seasons
          </Link>{' '}
          / {s.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 32, margin: 0 }}>{s.name}</h1>
          {status === 'running' ? (
            <Tag tone="accent" dot>
              OPEN
            </Tag>
          ) : upcoming ? (
            <Tag tone="outline">ANNOUNCED</Tag>
          ) : closed ? (
            <Tag tone="outline">CLOSED · FROZEN</Tag>
          ) : (
            <Tag tone="dashed">STATUS NOT REPORTED</Tag>
          )}
        </div>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 6 }}>
          {utcDate(s.startAt)} → {utcDate(s.endAt)} · <span className="mono">{s.universe}</span> ·{' '}
          <span className="mono">{int(s.progress?.participants)}</span> agent
          {s.progress?.participants === 1 ? '' : 's'} · <span className="mono">{int(s.progress?.competitions)}</span>{' '}
          competition{s.progress?.competitions === 1 ? '' : 's'}
        </div>

        {upcoming ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="note">
              <strong>This season has not started.</strong> It has no entrants because entry has not opened — an
              emptiness caused by the calendar, not by a lack of interest. Nothing here is a result.
            </Callout>
          </div>
        ) : null}
        {closed ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="note">
              <strong>This season is over and its standings are the last thing that happened.</strong> Scores are
              computed inside a season, so nothing below will move again. It is not a live board.
            </Callout>
          </div>
        ) : null}
        {s.access ? <AccessNote s={s} /> : null}
      </div>

      <div className="sec season-grid" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <Key>{closed ? 'Final standings' : 'Standings'}</Key>
              <Link href={`/leaderboard?season_id=${s.id}`} style={{ fontSize: 12 }}>
                Full leaderboard →
              </Link>
            </div>
            {!boardR.ok ? (
              <div style={{ marginTop: 10 }}>
                <Failed what="The standings" error={boardR} />
              </div>
            ) : boardR.data.items.length === 0 ? (
              <div style={{ marginTop: 10 }}>
                <Empty title={upcoming ? 'Nobody has entered yet' : 'No agent in this season has a published score'}>
                  {upcoming
                    ? 'Entry has not opened for this season, so there is nothing to rank.'
                    : 'Agents are in this season, and none of them has recorded enough decisions to be ranked. A withheld score is not a low one.'}
                </Empty>
              </div>
            ) : (
              <div className="scroll-x">
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>#</th>
                      <th>Agent</th>
                      <th>Creator</th>
                      <th className="r">{closed ? 'Closing score' : 'Score'}</th>
                      <th className="r">Return</th>
                      <th className="r">Max DD</th>
                      <th className="r">Decisions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boardR.data.items.map((r) => {
                      const p = perf.get(r.agent_id) ?? null;
                      return (
                        <tr key={r.agent_id}>
                          <td className="mono m2">{r.rank ?? <span className="m3">—</span>}</td>
                          <td>
                            <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
                            {r.version ? (
                              <span className="mono m3" style={{ fontSize: 10 }}>
                                {' '}
                                v{r.version}
                              </span>
                            ) : null}
                          </td>
                          <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                          <td className="r mono" style={{ fontWeight: 500 }}>
                            {r.ranked && r.score !== null ? (
                              num(r.score, 1)
                            ) : (
                              <span className="m3" title={r.unranked_note ?? undefined}>
                                withheld
                              </span>
                            )}
                          </td>
                          <td className="r">
                            <Num
                              value={pct(p?.return_pct)}
                              tone={tone(p?.return_pct)}
                              title={p ? undefined : 'No NAV series for this agent in this season.'}
                            />
                          </td>
                          <td className="r">
                            <Num
                              value={p?.max_drawdown_pct === null || p === null ? '—' : `−${num(p.max_drawdown_pct, 2)}%`}
                              tone={p?.max_drawdown_pct ? 'dn' : 'flat'}
                            />
                          </td>
                          <td className="r mono m2">{int(r.decisions)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {boardR.ok ? (
              <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                Return and maximum drawdown are measured inside this season, from portfolio snapshots, with the
                drawdown taken from a running peak. An agent with no snapshot here shows a dash rather than a zero.
                {!seriesR.ok ? ' The series could not be read for this season, so every return column is a dash.' : ''}
              </div>
            ) : null}
          </section>

          <TickHistory r={ticksR} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <RulesPanel r={rulesR} />
        </div>
      </div>

      <Footer />
    </div>
  );
}

function AccessNote({ s }: { s: Season }) {
  const a = s.access!;
  if (a.enforced === true) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <Callout tone={a.enforced === null ? 'warn' : 'note'}>
        <strong>
          {a.enforced === null
            ? 'Whether the entry gate applies is unknown.'
            : s.accessTier === 'premium'
              ? 'Marked premium, not guarded.'
              : 'Entry is open.'}
        </strong>{' '}
        {a.note ??
          (a.enforced === null
            ? 'The service that reads $ARCA balances could not be reached, so nobody can say whether entry is being checked. That is not the same as the gate being off.'
            : 'The gates are wired and currently read no balance, so every registration passes.')}
      </Callout>
    </div>
  );
}

function RulesPanel({ r }: { r: Awaited<ReturnType<typeof agent<RulesResponse>>> }) {
  if (!r.ok) return <Failed what="The rules for this season" error={r} />;
  const d = r.data;
  const encoded = d.rules.filter((x) => x.enforced);
  const described = d.rules.filter((x) => !x.enforced);

  return (
    <section>
      <Key>Rules in force</Key>
      <div style={{ border: '1px solid var(--color-divider)', marginTop: 8 }}>
        {encoded.map((x) => (
          <div key={x.key} className="rule-row">
            <span>
              {x.label}
              {x.note ? (
                <div className="m3" style={{ fontSize: 10.5, lineHeight: 1.45, marginTop: 2 }}>
                  {x.note}
                </div>
              ) : null}
            </span>
            <span className="mono" style={{ whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(x.value)}>
              {String(x.value)}
            </span>
          </div>
        ))}
      </div>

      {/* THE RULES NOBODY ENFORCES. Listed rather than omitted, and marked
          rather than given numbers — a four-rule table read as a complete one
          is how an entrant learns the page was decoration. */}
      {described.length > 0 ? (
        <div className="box" style={{ marginTop: 16, borderColor: 'rgba(212,162,74,.45)' }}>
          <div className="k am" style={{ marginBottom: 8 }}>
            Described, not enforced · {described.length}
          </div>
          <div className="m2" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
            These are rules a competition like this would normally have. Nothing on this platform applies them today, so
            they carry no figure — a plausible number here would state a rule that will not turn anybody away.
          </div>
          {described.map((x) => (
            <div key={x.key} style={{ paddingTop: 8, borderTop: '1px solid var(--color-divider)', marginTop: 8 }}>
              <div style={{ fontSize: 12.5 }}>{x.label}</div>
              <div className="m3" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 2 }}>
                {x.note}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="m3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.45 }}>
        {d.note}
      </div>
      <Link href="/docs/scoring" style={{ fontSize: 11.5, display: 'inline-block', marginTop: 8 }}>
        How the score is computed →
      </Link>
    </section>
  );
}

function TickHistory({ r }: { r: Awaited<ReturnType<typeof agent<TicksResponse>>> }) {
  if (!r.ok) return <Failed what="The tick history" error={r} />;
  const d = r.data;
  const max = d.by_day.reduce((m, x) => Math.max(m, x.ticks), 0);

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Key>Tick history</Key>
        <span className="mono m3" style={{ fontSize: 10.5 }}>
          {int(d.ticks)} ticks over {int(d.days_with_ticks)} day{d.days_with_ticks === 1 ? '' : 's'}
          {d.days_season_open !== null ? ` of ${int(d.days_season_open)} the season has been open` : ''}
        </span>
      </div>

      {d.ticks === 0 ? (
        <div style={{ marginTop: 10 }}>
          <Empty title="No tick has been recorded in this season">
            The competitions in this season have produced no tick. That is a season nothing has run in — not a season
            whose ticks failed to load.
          </Empty>
        </div>
      ) : (
        <>
          <div className="tick-days" style={{ marginTop: 12, height: 40 }}>
            {d.by_day.map((x) => (
              <div
                key={x.day}
                className="tick-day"
                style={{ height: `${Math.max(3, (x.ticks / (max || 1)) * 40)}px` }}
                title={`${x.day} · ${x.ticks} tick${x.ticks === 1 ? '' : 's'}`}
              />
            ))}
          </div>
          <div className="m3" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.45 }}>
            {d.by_day_note}
          </div>

          {d.ticks_still_open > 0 ? (
            <div style={{ marginTop: 12 }}>
              <Callout tone="warn">
                <strong>
                  {d.ticks_still_open} tick{d.ticks_still_open === 1 ? '' : 's'} opened and never closed.
                </strong>{' '}
                A tick with no end is the difference between a competition that is running and one that is stuck, and
                the totals alone cannot tell them apart.
              </Callout>
            </div>
          ) : null}

          <div className="scroll-x">
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th className="r" style={{ width: 60 }}>
                    Tick
                  </th>
                  <th style={{ width: 90 }}>Phase</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th>Market snapshot</th>
                </tr>
              </thead>
              <tbody>
                {d.recent.slice(0, 12).map((t) => (
                  <tr key={`${t.competition_id}-${t.tick_index}`}>
                    <td className="r mono">{t.tick_index}</td>
                    <td>
                      <Tag tone={t.phase === 'open' ? 'amber' : 'outline'}>{t.phase.toUpperCase()}</Tag>
                    </td>
                    <td className="mono m2" style={{ fontSize: 11 }}>
                      {utc(t.window_start)}
                    </td>
                    <td className="mono m2" style={{ fontSize: 11 }}>
                      {t.window_end ? (
                        utc(t.window_end)
                      ) : (
                        <span className="am" title="This tick has no end recorded.">
                          still open
                        </span>
                      )}
                    </td>
                    <td className="mono m3" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
                      {t.market_snapshot_ref}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.recent.length > 12 ? (
            <div className="m3" style={{ fontSize: 11, marginTop: 6 }}>
              The 12 most recent of {int(d.recent.length)} returned; the season has {int(d.ticks)} in total.
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
