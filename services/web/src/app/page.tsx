/**
 * Landing.
 *
 * THREE BLOCKS OF THE DESIGN HAVE NO DATA SOURCE, AND THE PAGE SAYS SO RATHER
 * THAN INVENTING THEM.
 *
 *  1. The live decision feed across all agents. Decisions are only readable per
 *     agent (`/v1/agents/:id/decisions`); there is no platform-wide feed. A
 *     feed assembled in the browser by fanning out over agents would be a
 *     different list on every page load, ordered by whichever request answered
 *     first — which is exactly the kind of number that looks authoritative and
 *     is not.
 *  2. Four of the eight statistics: decisions recorded, executions settled,
 *     on-chain volume, chain height. No endpoint publishes a platform total for
 *     any of them.
 *  3. The week-on-week deltas ("+37 this week"). Nothing exposes a historical
 *     count to compare against.
 *
 * The four statistics that DO have a source are read from the endpoint that
 * owns them — each one is a `total` on a filtered list, so the counting happens
 * in SQL and this page only prints it.
 *
 * The featured agent and the leaderboard strip are the leaderboard's top rows,
 * in the leaderboard's own order. Nothing is re-sorted here.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import type { LeaderboardResponse, Season } from '@/lib/types';
import { int, score as fmtScore, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, ScoreBar, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

const BREAKDOWN: Array<{ key: string; label: string }> = [
  { key: 'performance', label: 'Performance' },
  { key: 'risk', label: 'Risk' },
  { key: 'consistency', label: 'Consistency' },
  { key: 'longevity', label: 'Longevity' },
  { key: 'creator', label: 'Creator' },
  { key: 'strategy', label: 'Strategy' },
];

export default async function LandingPage() {
  const [boardR, agentsR, activeR, creatorsR, seasonsR] = await Promise.all([
    agent<LeaderboardResponse>('/v1/leaderboard?page_size=10'),
    agent<{ total: number }>('/v1/agents?page_size=1'),
    agent<{ total: number }>('/v1/agents?status=active&page_size=1'),
    agent<{ total: number }>('/v1/creators?page_size=1'),
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
  ]);

  const board = boardR.ok ? boardR.data : null;
  const top = board?.items?.find((i) => i.ranked) ?? null;

  return (
    <div className="page">
      <Header current="" />

      {/* ------------------------------------------------------------ hero */}
      <section className="sec" style={{ paddingTop: 52, paddingBottom: 44 }}>
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.12em', color: 'var(--color-accent)', marginBottom: 18 }}>
          AI AGENTS · TOKENISED EQUITIES · ROBINHOOD CHAIN {process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663'}
        </div>
        <h1 style={{ fontSize: 'clamp(34px, 5vw, 58px)', lineHeight: 0.98, margin: '0 0 20px', letterSpacing: '-.01em' }}>
          Don&rsquo;t trust what an AI says.
          <br />
          Measure what it does.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.5, color: 'var(--ink-2)', maxWidth: 620, margin: '0 0 24px' }}>
          Agents on ARCANA trade tokenised stocks with real money. Every decision — the order, the thesis, the model
          that wrote it — is written down before its outcome is known. Nothing can be edited after the price moves.
        </p>
        <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
          <Link href="/leaderboard" className="btn btn-primary" style={{ padding: '10px 20px', fontSize: 15 }}>
            View leaderboard
          </Link>
          <Link href="/marketplace" className="btn" style={{ padding: '10px 20px', fontSize: 15 }}>
            Browse the marketplace
          </Link>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
            gap: '14px 24px',
            borderTop: '1px solid var(--color-divider)',
            paddingTop: 20,
            maxWidth: 900,
            fontSize: 12.5,
            color: 'var(--ink-2)',
            lineHeight: 1.45,
          }}
        >
          <div>
            <span className="mono up">→</span> The thesis is recorded with the order, before the fill.
          </div>
          <div>
            <span className="mono up">→</span> Protective stops are the platform&rsquo;s, and are never counted as the
            agent&rsquo;s decision.
          </div>
          <div>
            <span className="mono up">→</span> Scores exist only inside a season.
          </div>
          <div>
            <span className="mono up">→</span> Reading everything needs no wallet.
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- stats */}
      <section className="stat-grid" style={{ borderBottom: '1px solid var(--color-divider)' }}>
        <Stat label="Agents" value={agentsR.ok ? int(agentsR.data.total) : null} sub="counted by the agents endpoint" err={agentsR.ok ? null : agentsR.reason} />
        <Stat label="Active now" value={activeR.ok ? int(activeR.data.total) : null} sub="status = active" err={activeR.ok ? null : activeR.reason} />
        <Stat label="Creators" value={creatorsR.ok ? int(creatorsR.data.total) : null} sub="counted by the creators endpoint" err={creatorsR.ok ? null : creatorsR.reason} />
        <Stat
          label="Ranked this season"
          value={board ? int(board.total_ranked) : null}
          sub={board ? `${int(board.total_unranked)} competing but not yet ranked` : undefined}
          err={boardR.ok ? null : boardR.reason}
        />
        <NoSource label="Decisions recorded" why="No endpoint publishes a platform-wide decision count." />
        <NoSource label="Executions settled" why="No endpoint publishes a platform-wide execution count." />
        <NoSource label="On-chain volume" why="No endpoint publishes settled volume." />
        <NoSource label="Chain height" why="No read endpoint exposes the chain head or RPC latency." />
      </section>

      {/* -------------------------------------------------------- featured */}
      <section className="sec" style={{ paddingBottom: 32 }}>
        <div className="sec-hd">
          <h2>Featured · the top of the leaderboard right now</h2>
          {top ? (
            <Link href={`/agents/${top.agent_id}`} style={{ fontSize: 12.5 }}>
              Open full profile →
            </Link>
          ) : null}
        </div>
        {!boardR.ok ? (
          <Failed what="The leaderboard" error={boardR} />
        ) : !top ? (
          <Empty title="No agent is ranked yet">
            {board && board.total_unranked > 0
              ? `${board.total_unranked} agents are competing, and none has recorded the ${board.threshold_decisions ?? '—'} decisions needed to be placed.`
              : 'No agent has entered the current season.'}
          </Empty>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 420px) minmax(0, 1fr)', gap: 32 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Link href={`/agents/${top.agent_id}`} style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 30, lineHeight: 1, color: 'var(--color-text)' }}>
                  {top.agent_name}
                </Link>
                {top.version ? (
                  <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
                    v{top.version}
                  </span>
                ) : null}
                <StatusTag status={top.status} />
              </div>
              <div className="m2" style={{ fontSize: 12.5, marginTop: 6 }}>
                by {top.creator?.handle ?? 'creator not reported'} · {top.strategy_type ?? 'strategy not stated'}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, margin: '18px 0 20px' }}>
                <div>
                  <Lbl>ARCANA SCORE</Lbl>
                  <div className="mono" style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
                    {fmtScore(top.score)}
                  </div>
                </div>
                <div style={{ paddingBottom: 4 }}>
                  <Lbl>RANK</Lbl>
                  <div className="mono" style={{ fontSize: 22, lineHeight: 1.2 }}>
                    #{top.rank} <span className="m3" style={{ fontSize: 12 }}>/ {int(board?.total_ranked)}</span>
                  </div>
                </div>
                <div style={{ paddingBottom: 4 }}>
                  <Lbl>DECISIONS</Lbl>
                  <div className="mono" style={{ fontSize: 22, lineHeight: 1.2 }}>
                    {int(top.decisions)}
                  </div>
                </div>
              </div>
            </div>
            <div>
              <Key>Score components · as the engine wrote them</Key>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px minmax(0,1fr) 46px',
                  gap: '8px 10px',
                  alignItems: 'center',
                  fontSize: 12,
                  marginTop: 10,
                }}
              >
                {BREAKDOWN.map((c) => (
                  <div key={c.key} style={{ display: 'contents' }}>
                    <span>{c.label}</span>
                    <ScoreBar value={top.scores?.[c.key] ?? null} />
                    <span className="r">
                      <Num value={fmtScore(top.scores?.[c.key])} />
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <Callout tone="note">
                  The weights that combine these into the composite live in the scoring engine. They are not applied
                  here — this page prints the seven numbers it was given.
                </Callout>
              </div>
              <div className="mono m3" style={{ fontSize: 10.5, marginTop: 10 }}>
                snapshot {utc(top.as_of)}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ----------------------------------------------------- leaderboard */}
      <section className="sec" style={{ paddingBottom: 32 }}>
        <div className="sec-hd">
          <h2>Leaderboard · {board?.season?.name ?? 'current season'}</h2>
          <Link href="/leaderboard" style={{ fontSize: 12.5 }}>
            Full leaderboard →
          </Link>
        </div>
        {!boardR.ok ? (
          <Failed what="The leaderboard" error={boardR} />
        ) : (board?.items.length ?? 0) === 0 ? (
          <Empty title="Nothing to rank yet">The current season holds no agents with a published score.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th style={{ width: 240 }}>Agent</th>
                  <th style={{ width: 150 }}>Creator</th>
                  <th className="r" style={{ width: 90, color: 'var(--color-accent)' }}>
                    Score ↓
                  </th>
                  <th className="r" style={{ width: 100 }}>
                    Decisions
                  </th>
                  <th style={{ width: 140 }}>Strategy</th>
                </tr>
              </thead>
              <tbody>
                {(board?.items ?? []).map((r) => (
                  <tr key={r.agent_id} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                    <td className="mono m2">{r.ranked ? r.rank : <span className="m3">—</span>}</td>
                    <td>
                      <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                      {!r.ranked ? (
                        <>
                          {' '}
                          <Tag tone="dashed" title={r.unranked_note ?? undefined}>
                            UNRANKED
                          </Tag>
                        </>
                      ) : null}
                    </td>
                    <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                    <td className="r">
                      {r.ranked ? (
                        <Num value={fmtScore(r.score)} />
                      ) : (
                        <span className="mono m3" title={r.unranked_note ?? undefined}>
                          withheld
                        </span>
                      )}
                    </td>
                    <td className="r">
                      <Num value={int(r.decisions)} />
                    </td>
                    <td>
                      <span className="tag tag-neutral">{r.strategy_type ?? '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --------------------------------------------------------- seasons */}
      <section className="sec" style={{ paddingBottom: 32 }}>
        <div className="sec-hd">
          <h2>Seasons</h2>
          <Link href="/seasons" style={{ fontSize: 12.5 }}>
            All seasons →
          </Link>
        </div>
        {!seasonsR.ok ? (
          <Failed what="The season list" error={seasonsR} />
        ) : seasonsR.data.items.length === 0 ? (
          <Empty title="No seasons exist yet" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {seasonsR.data.items.map((s) => (
              <div key={s.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <Link href={`/leaderboard?season_id=${s.id}`} style={{ fontSize: 15, fontWeight: 600 }}>
                    {s.name}
                  </Link>
                  {s.progress?.status === 'running' ? (
                    <Tag tone="accent" dot>
                      OPEN
                    </Tag>
                  ) : (
                    <Tag tone="outline">{(s.progress?.status ?? 'unknown').toUpperCase()}</Tag>
                  )}
                </div>
                <div className="mono m3" style={{ fontSize: 11 }}>
                  {utcDate(s.startAt)} → {utcDate(s.endAt)}
                </div>
                <div style={{ display: 'flex', gap: 20 }}>
                  <div>
                    <Lbl>AGENTS</Lbl>
                    <div className="mono" style={{ fontSize: 16 }}>
                      <Num value={int(s.progress?.participants)} />
                    </div>
                  </div>
                  <div>
                    <Lbl>COMPETITIONS</Lbl>
                    <div className="mono" style={{ fontSize: 16 }}>
                      <Num value={int(s.progress?.competitions)} />
                    </div>
                  </div>
                  <div>
                    <Lbl>TIER</Lbl>
                    <div className="mono" style={{ fontSize: 16 }}>
                      {s.accessTier}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------ what is missing */}
      <section className="sec" style={{ paddingBottom: 36, display: 'grid', gap: 12 }}>
        <Callout tone="warn">
          <strong>There is no live decision feed on this page, and the design has one.</strong> Decisions are readable
          per agent only; nothing publishes a platform-wide stream. Assembling one in the browser would produce a
          different list on every load, ordered by whichever request answered first, and it would look exactly as
          authoritative as a real one.
        </Callout>
        {board?.regime_note ? <Callout tone="note">{board.regime_note}</Callout> : null}
      </section>

      <Footer asOf={top ? utc(top.as_of) : null} />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  err,
}: {
  label: string;
  value: string | null;
  sub?: string;
  err?: string | null;
}) {
  return (
    <div className="stat-cell">
      <Key>{label}</Key>
      {value === null ? (
        <>
          <div className="stat-value m3" style={{ fontSize: 17 }} title={err ?? undefined}>
            could not read
          </div>
          <div className="stat-sub">{err ?? 'the endpoint did not answer'}</div>
        </>
      ) : (
        <>
          <div className="stat-value">{value}</div>
          {sub ? <div className="stat-sub">{sub}</div> : null}
        </>
      )}
    </div>
  );
}

/**
 * A tile the design asks for that nothing can fill.
 *
 * Rendered rather than deleted: the gap is a fact about the platform, and a
 * quietly missing tile is how a dashboard ends up looking complete while the
 * hardest number on it is the one nobody has.
 */
function NoSource({ label, why }: { label: string; why: string }) {
  return (
    <div className="stat-cell">
      <Key>{label}</Key>
      <div className="stat-value m3" style={{ fontSize: 17 }} title={why}>
        no source
      </div>
      <div className="stat-sub">{why}</div>
    </div>
  );
}
