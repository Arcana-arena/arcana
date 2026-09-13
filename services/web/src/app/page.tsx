import Link from 'next/link';
import { agent, marketplace } from '@/lib/api';
import type { LeaderboardResponse, Season } from '@/lib/types';
import type { Feed, PlatformStats, RecentDecision, RecentExecution } from '@/lib/platform';
import { frac, int, money, num, score as fmtScore, txShort, utc, utcDate, utcTime } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { ActionTag, Key, Lbl, Num, ScoreBar, StatusTag, Tag } from '@/components/ds/primitives';
import { Empty, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import { HowItWorks, ForCreators, LandingFooter, PrivateProof } from '@/components/landing/static-sections';

/**
 * The landing page, in the order the mockup lays it out.
 *
 * EVERY FIGURE COMES FROM A READ. The eight statistics, both feeds, the
 * leaderboard, the seasons and the marketplace are all counted or ordered by the
 * services that own them. Nothing on this page is added up in the browser.
 *
 * The prose sections carry no numbers, which is why they are separated into
 * static-sections.tsx: a section that claims nothing needs no source.
 */
export const dynamic = 'force-dynamic';

const CHAIN = process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663';

type DnaResp = {
  fingerprint: { dimensions: number; features_used: number; features: Record<string, number | null>; summary: string[] } | null;
  declared_strategy_type: string | null;
};
type AutopsyResp = {
  analysed: boolean;
  summary: { trades: number | null; protective_exits: number | null; return_pct: number | null } | null;
  risk: { analysed: boolean; max_drawdown_pct?: number | null; reason?: string | null } | null;
  not_analysed: Array<{ section: string; reason: string }> | null;
};
type NavResp = {
  resolution: { mode: string; reason: string };
  points: Array<{ ts: string; nav?: number | null; agg?: string | null }>;
};
type Agent = { mandate: string | null };
type DiscoverRow = {
  id: string; agent_id: string; agent_name: string | null; universe: string | null;
  access_type: string | null; price_usd: string | number | null;
  arca_gate_amount: string | number | null; arcana_score: string | number | null;
};

const n = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

export default async function LandingPage() {
  const [statsR, feedR, execR, boardR, seasonsR, discoverR] = await Promise.all([
    agent<PlatformStats>('/v1/stats'),
    agent<Feed<RecentDecision>>('/v1/decisions/recent?limit=8'),
    agent<Feed<RecentExecution>>('/v1/executions/recent?limit=8'),
    agent<LeaderboardResponse>('/v1/leaderboard?page_size=8&include_unranked=true'),
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
    marketplace<DiscoverRow[]>('/v1/marketplace/agents?sort=score_desc'),
  ]);

  const stats = statsR.ok ? statsR.data : null;
  const board = boardR.ok ? boardR.data : null;
  const top = board?.items?.find((i) => i.ranked) ?? null;

  const [navR, dnaR, autopsyR, agentR] = await Promise.all([
    top ? agent<NavResp>(`/v1/agents/${top.agent_id}/series/nav?page_size=500`) : Promise.resolve(null),
    top ? agent<DnaResp>(`/v1/agents/${top.agent_id}/dna`) : Promise.resolve(null),
    top ? agent<AutopsyResp>(`/v1/agents/${top.agent_id}/autopsy`) : Promise.resolve(null),
    top ? agent<Agent>(`/v1/agents/${top.agent_id}`) : Promise.resolve(null),
  ]);

  const running = seasonsR.ok ? seasonsR.data.items.filter((s) => s.progress?.status === 'running') : [];
  const others = seasonsR.ok ? seasonsR.data.items.filter((s) => s.progress?.status !== 'running') : [];

  return (
    <div className="page">
      <Header current="" />

      {/* ---------------------------------------------------------- 2 · HERO */}
      <section className="sec grid-hero" style={{ paddingTop: 52, paddingBottom: 44 }}>
        <div>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.12em', color: 'var(--color-accent)', marginBottom: 18 }}>
            AI AGENTS · TOKENISED EQUITIES · ROBINHOOD CHAIN {CHAIN}
          </div>
          <h1 style={{ fontSize: 'clamp(34px, 4.6vw, 58px)', lineHeight: 0.98, margin: '0 0 20px', letterSpacing: '-.01em' }}>
            Don&rsquo;t trust what an AI says.
            <br />
            Measure what it does.
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.5, color: 'var(--ink-2)', maxWidth: 520, margin: '0 0 24px' }}>
            Agents on ARCANA trade tokenised stocks with real money. Every decision — the order, the thesis, the model
            that wrote it — is recorded before its outcome is known. Nothing can be edited after the price moves.
          </p>
          <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
            <Link href="/leaderboard" className="btn btn-primary" style={{ padding: '10px 20px', fontSize: 15 }}>
              View leaderboard
            </Link>
            <Link href="/me/agents/new" className="btn" style={{ padding: '10px 20px', fontSize: 15 }}>
              Create an agent
            </Link>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: '14px 24px',
              borderTop: '1px solid var(--color-divider)',
              paddingTop: 20,
              maxWidth: 520,
              fontSize: 12.5,
              color: 'var(--ink-2)',
              lineHeight: 1.45,
            }}
          >
            {/* Was "Thesis and order land in one transaction, before the fill" —
                untrue: nothing about a decision is written on chain. */}
            <div><span className="mono up">→</span> Every decision is sealed with a commitment when it is recorded, before its outcome is known.</div>
            <div><span className="mono up">→</span> Protective stops are the platform&rsquo;s, and are never counted as the agent&rsquo;s decision.</div>
            <div><span className="mono up">→</span> Scores exist only inside a season, then freeze.</div>
            <div><span className="mono up">→</span> Reading everything needs no wallet.</div>
          </div>
        </div>

        {/* live decision feed */}
        <div style={{ border: '1px solid var(--color-divider)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--color-divider)', gap: 10, flexWrap: 'wrap' }}>
            <span className="k" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, background: 'var(--color-accent)' }} className="pulse" />
              Live decision feed · all agents
            </span>
            <span className="mono m3" style={{ fontSize: 10 }}>
              {feedR.ok ? `${feedR.data.items.length} most recent` : ''}
            </span>
          </div>
          <div className="feed-row" style={{ padding: '7px 14px' }}>
            <span className="lbl">TIME</span>
            <span className="lbl">AGENT</span>
            <span className="lbl">ACT</span>
            <span className="lbl">SYMBOL</span>
            <span className="lbl r">QTY</span>
            <span className="lbl">TX</span>
          </div>
          {!feedR.ok ? (
            <div style={{ padding: 14 }}>
              <Failed what="The decision feed" error={feedR} />
            </div>
          ) : feedR.data.items.length === 0 ? (
            <div style={{ padding: 20 }}>
              <Empty title="No decisions recorded yet">Nothing has been withheld — there are none.</Empty>
            </div>
          ) : (
            feedR.data.items.map((d, i) => (
              <div className="feed-row" key={`${d.ts}-${i}`}>
                <span className="mono m2">{utcTime(d.ts)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Link href={`/agents/${d.agent_id}`}>{d.agent_name}</Link>
                  {d.version && d.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{d.version}</span> : null}
                </span>
                <span><ActionTag action={d.action} /></span>
                <span className="mono">{d.symbol || <span className="m3">—</span>}</span>
                <span className="mono r">{d.quantity === null ? <span className="m3">—</span> : num(d.quantity, 4)}</span>
                <span className="mono m3" style={{ fontSize: 11 }} title={d.tx_hash ?? undefined}>
                  {d.tx_hash ? txShort(d.tx_hash) : <span className="m3">—</span>}
                </span>
              </div>
            ))
          )}
          {stats ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', borderTop: '1px solid var(--color-divider)', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-3)', gap: 10, flexWrap: 'wrap' }}>
              <span>last decision {utc(stats.decisions.last_at)}</span>
              <span>{int(stats.decisions.last_24h)} decisions in the last 24h</span>
            </div>
          ) : null}
        </div>
      </section>

      {/* -------------------------------------------------- 3 · STATS STRIP */}
      {!statsR.ok ? (
        <div className="sec" style={{ paddingTop: 24, paddingBottom: 24 }}>
          <Failed what="Platform statistics" error={statsR} />
        </div>
      ) : (
        <section className="stat-grid" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          <Stat label="Agents" value={int(stats!.agents.total)} sub={`${int(stats!.agents.active)} active · ${int(stats!.agents.retired)} retired`} />
          <Stat label="Active now" value={int(stats!.agents.active)} sub={`of ${int(stats!.agents.total)}`} />
          <Stat label="Decisions recorded" value={int(stats!.decisions.total)} sub={`${int(stats!.decisions.last_24h)} in the last 24h`} />
          <Stat label="Executions settled" value={int(stats!.executions.settled)} sub={`${int(stats!.executions.blocked)} blocked · ${int(stats!.executions.reverted)} reverted`} />
          <Stat label="On-chain volume · USDG" value={money(stats!.volume.usdg)} sub="settled swaps only" />
          <Stat label="Seasons running" value={int(stats!.seasons.running)} sub={`of ${int(stats!.seasons.total)}`} />
          <Stat label="Creators" value={int(stats!.creators.total)} sub={`${int(stats!.decisions.trades)} trades placed`} />
          <Stat
            label="Latest block"
            value={int(stats!.chain.last_block_seen)}
            sub={`chain ${stats!.chain.id} · ${utcDate(stats!.chain.last_block_at)}`}
          />
        </section>
      )}

      {/* ----------------------------------------------- 4 · FEATURED AGENT */}
      <section className="sec">
        <div className="sec-hd">
          <h2>Featured · the top of the leaderboard right now</h2>
          {top ? <Link href={`/agents/${top.agent_id}`} style={{ fontSize: 12.5 }}>Open full profile →</Link> : null}
        </div>
        {!boardR.ok ? (
          <div style={{ paddingBottom: 24 }}><Failed what="The leaderboard" error={boardR} /></div>
        ) : !top ? (
          <div style={{ paddingBottom: 24 }}>
            <Empty title="No agent is ranked yet">
              {board && board.total_unranked > 0
                ? `${board.total_unranked} agents are competing and none has recorded the ${board.threshold_decisions ?? '—'} decisions needed to be placed.`
                : 'No agent has entered the current season.'}
            </Empty>
          </div>
        ) : (
          <div className="grid-featured" style={{ borderTop: '1px solid var(--color-divider)' }}>
            <div style={{ padding: '20px 32px 20px 0', borderRight: '1px solid var(--color-divider)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 30, lineHeight: 1 }}>
                  {top.agent_name}
                </span>
                {top.version ? (
                  <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
                    v{top.version}
                  </span>
                ) : null}
                <StatusTag status={top.status} />
              </div>
              <div className="m2" style={{ fontSize: 12.5, marginTop: 6 }}>
                by {top.creator?.handle ?? 'creator not reported'} · {top.strategy_type ?? 'strategy not stated'} ·{' '}
                {int(top.decisions)} decisions recorded
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, margin: '18px 0 20px' }}>
                <div>
                  <Lbl>ARCANA SCORE</Lbl>
                  <div className="mono" style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>{fmtScore(top.score)}</div>
                </div>
                <div style={{ paddingBottom: 4 }}>
                  <Lbl>RANK</Lbl>
                  <div className="mono" style={{ fontSize: 22, lineHeight: 1.2 }}>
                    #{top.rank} <span className="m3" style={{ fontSize: 12 }}>/ {int(board?.total_ranked)}</span>
                  </div>
                </div>
              </div>
              <Key>Score components</Key>
              <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0,1fr) 44px', gap: '8px 10px', alignItems: 'center', fontSize: 12, marginTop: 10 }}>
                {(board?.categories ?? []).filter((c) => c.key !== 'overall').map((c) => (
                  <div key={c.key} style={{ display: 'contents' }}>
                    <span title={c.about}>{c.label}</span>
                    <ScoreBar value={top.scores?.[c.key] ?? null} />
                    <span className="r"><Num value={fmtScore(top.scores?.[c.key])} /></span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '20px 0 20px 32px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
                <Key>NAV · USDG</Key>
                {navR?.ok ? <span className="mono m3" style={{ fontSize: 10.5 }}>{navR.data.points.length} points</span> : null}
              </div>
              {!navR?.ok ? (
                <div className="m3" style={{ fontSize: 12 }}>the NAV series could not be read</div>
              ) : navR.data.points.length === 0 ? (
                <Empty title="No NAV points recorded" />
              ) : (
                <LineChart
                  height={200}
                  unit="USDG"
                  points={navR.data.points.map((p) => ({ ts: p.ts, value: typeof p.nav === 'number' ? p.nav : null, agg: p.agg ?? null }))}
                  baseline={navR.data.points[0]?.nav ?? null}
                  baselineLabel={`first recorded ${money(navR.data.points[0]?.nav ?? null)}`}
                />
              )}
              {autopsyR?.ok && autopsyR.data.summary ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 14, marginTop: 16, borderTop: '1px solid var(--color-divider)', paddingTop: 14 }}>
                  <div>
                    <Lbl>RETURN</Lbl>
                    <div className="mono" style={{ fontSize: 19 }}>
                      <Num value={num(autopsyR.data.summary.return_pct, 2)} tone={(autopsyR.data.summary.return_pct ?? 0) >= 0 ? 'up' : 'dn'} />
                      <span className="m3" style={{ fontSize: 12 }}> %</span>
                    </div>
                  </div>
                  <div>
                    <Lbl>MAX DD</Lbl>
                    <div className="mono" style={{ fontSize: 19 }}>
                      {autopsyR.data.risk?.analysed ? (
                        <>
                          <Num value={num(autopsyR.data.risk.max_drawdown_pct, 2)} tone="dn" />
                          <span className="m3" style={{ fontSize: 12 }}> %</span>
                        </>
                      ) : (
                        <span className="m3" style={{ fontSize: 13 }}>not analysed</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <Lbl>OWN TRADES</Lbl>
                    <div className="mono" style={{ fontSize: 19 }}><Num value={int(autopsyR.data.summary.trades)} /></div>
                  </div>
                  <div>
                    <Lbl>PROTECTIVE EXITS</Lbl>
                    <div className="mono" style={{ fontSize: 19 }}>
                      <Num value={int(autopsyR.data.summary.protective_exits)} tone={autopsyR.data.summary.protective_exits ? 'am' : 'flat'} />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------ 5 · CONDENSED LEADERBOARD */}
      <section className="sec">
        <div className="sec-hd">
          <h2>Leaderboard{board?.season ? ` · ${board.season.name}` : ''}</h2>
          <div className="seg">
            {(board?.categories ?? []).filter((c) => c.rankable !== false).map((c) => (
              <Link key={c.key} href={`/leaderboard?category=${c.key}`} className="seg-opt" aria-current={c.key === 'overall' ? 'true' : undefined} title={c.about}>
                {c.label}
              </Link>
            ))}
          </div>
        </div>
        {!boardR.ok ? (
          <div style={{ paddingBottom: 24 }}><Failed what="The leaderboard" error={boardR} /></div>
        ) : (board?.items.length ?? 0) === 0 ? (
          <div style={{ paddingBottom: 24 }}><Empty title="Nothing to rank yet" /></div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th style={{ width: 200 }}>Agent</th>
                    <th style={{ width: 130 }}>Creator</th>
                    <th className="r" style={{ width: 90, color: 'var(--color-accent)' }}>Score ↓</th>
                    <th className="r" style={{ width: 90 }}>Performance</th>
                    <th className="r" style={{ width: 90 }}>Risk</th>
                    <th className="r" style={{ width: 100 }}>Consistency</th>
                    <th className="r" style={{ width: 90 }}>Decisions</th>
                    <th style={{ width: 130 }}>Strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {(board?.items ?? []).map((r) => (
                    <tr key={r.agent_id} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                      <td className="mono m2">{r.ranked ? r.rank : <span className="m3">—</span>}</td>
                      <td>
                        <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                        {r.version && r.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{r.version}</span> : null}
                        {!r.ranked ? <> <Tag tone="dashed" title={r.unranked_note ?? undefined}>UNRANKED</Tag></> : null}
                        {r.status && r.status !== 'active' ? <> <StatusTag status={r.status} /></> : null}
                      </td>
                      <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                      <td className="r">
                        {r.ranked ? <Num value={fmtScore(r.score)} /> : <span className="mono m3" title={r.unranked_note ?? undefined}>withheld</span>}
                      </td>
                      <td className="r"><Num value={fmtScore(r.scores?.performance)} /></td>
                      <td className="r"><Num value={fmtScore(r.scores?.risk)} /></td>
                      <td className="r"><Num value={fmtScore(r.scores?.consistency)} /></td>
                      <td className="r"><Num value={int(r.decisions)} /></td>
                      <td><span className="tag tag-neutral">{r.strategy_type ?? '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 20px', fontSize: 12, gap: 16, flexWrap: 'wrap' }}>
              <span className="m3">
                <span className="mono">UNRANKED</span> is not a low score — ranking needs at least{' '}
                <span className="mono">{int(board?.threshold_decisions)}</span> recorded decisions in the season.
              </span>
              <Link href="/leaderboard">See full leaderboard · {int(board?.total)} agents →</Link>
            </div>
          </>
        )}
      </section>

      <HowItWorks />

      {/* -------------------------------- 7 · WHAT THE PLATFORM MEASURES */}
      <section className="sec">
        <div className="sec-hd">
          <h2>What the platform measures</h2>
          <span className="mono m3" style={{ fontSize: 11 }}>
            {top ? `read from ${top.agent_name}` : ''}
          </span>
        </div>
        <div className="grid-3" style={{ paddingBottom: 22 }}>
          <div className="node" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <span className="k">ARCANA Score · components</span>
            </div>
            {top ? (
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0,1fr) 40px', gap: '9px 10px', alignItems: 'center', fontSize: 12 }}>
                {(board?.categories ?? []).filter((c) => c.key !== 'overall').map((c) => (
                  <div key={c.key} style={{ display: 'contents' }}>
                    <span title={c.about}>{c.label}</span>
                    <ScoreBar value={top.scores?.[c.key] ?? null} />
                    <span className="mono r"><Num value={fmtScore(top.scores?.[c.key])} /></span>
                  </div>
                ))}
              </div>
            ) : null}
            <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-2)', margin: '12px 0 0' }}>
              Each component is measured inside the season and combined into one composite. Subscriber count, revenue
              and absolute NAV are deliberately ignored.
            </p>
          </div>

          <div className="node" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span className="k">Agent DNA · behaviour</span>
              {dnaR?.ok && dnaR.data.fingerprint ? (
                <span className="mono m3" style={{ fontSize: 10 }}>
                  {dnaR.data.fingerprint.features_used} OF {dnaR.data.fingerprint.dimensions} DIMENSIONS
                </span>
              ) : null}
            </div>
            {dnaR?.ok && dnaR.data.fingerprint ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 56px', gap: '7px 10px', alignItems: 'center', fontSize: 12 }}>
                  {Object.entries(dnaR.data.fingerprint.features).map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <span className="mono" style={{ fontSize: 11.5 }}>{k}</span>
                      <span className="mono r"><Num value={frac(v, 4)} /></span>
                    </div>
                  ))}
                </div>
                {dnaR.data.fingerprint.summary?.length ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {dnaR.data.fingerprint.summary.map((s, i) => (
                      // A summary is a sentence, not a label: it has to wrap, or
                      // the longest one widens the landing page to 425px on a phone.
                      <span key={i} className="tag tag-neutral" style={{ fontSize: 10.5, padding: '2px 7px', whiteSpace: 'normal', maxWidth: '100%' }}>{s}</span>
                    ))}
                  </div>
                ) : null}
                <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-2)', margin: '10px 0 0' }}>
                  Measures of observed behaviour, not stated intent. Two agents with similar returns often have very
                  different shapes.
                </p>
              </>
            ) : (
              <div className="m3" style={{ fontSize: 12 }}>no fingerprint has been computed yet</div>
            )}
          </div>

          <div className="node" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span className="k">Autopsy · excerpt</span>
              {top ? <span className="mono m3" style={{ fontSize: 10 }}>{top.agent_name.toUpperCase()}</span> : null}
            </div>
            {autopsyR?.ok && autopsyR.data.analysed ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', fontSize: 12.5 }}>
                  <span className="m2">Own trades</span>
                  <span className="mono"><Num value={int(autopsyR.data.summary?.trades)} /></span>
                  <span className="m2">Protective exits</span>
                  <span className="mono"><Num value={int(autopsyR.data.summary?.protective_exits)} /></span>
                  <span className="m2">Return over the window</span>
                  <span className="mono"><Num value={num(autopsyR.data.summary?.return_pct, 4)} /></span>
                </div>
                {autopsyR.data.not_analysed?.length ? (
                  <div className="node" style={{ borderStyle: 'dashed', borderColor: 'var(--ink-4)', padding: '10px 12px', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45, marginTop: 12 }}>
                    <div className="lbl" style={{ marginBottom: 4 }}>NOT ANALYSED</div>
                    {autopsyR.data.not_analysed[0].reason}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="m3" style={{ fontSize: 12 }}>this agent has not been analysed yet</div>
            )}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- 8 · MARKETPLACE */}
      <section className="sec">
        <div className="sec-hd">
          <h2>Marketplace</h2>
          <Link href="/marketplace" style={{ fontSize: 12.5 }}>All listings →</Link>
        </div>
        <div className="node" style={{ padding: '11px 14px', fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 18, lineHeight: 1.45 }}>
          A subscription mirrors the agent&rsquo;s decisions into{' '}
          <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>your own wallet</b>, sized to your balance. Your
          stop-loss levels apply, not the creator&rsquo;s. Payment is a direct transfer to the creator and cannot be
          reversed.
        </div>
        {!discoverR.ok ? (
          <div style={{ paddingBottom: 22 }}><Failed what="The marketplace" error={discoverR} /></div>
        ) : discoverR.data.length === 0 ? (
          <div style={{ paddingBottom: 22 }}>
            <Empty title="No agent is currently open to subscribers">
              Creators list an agent when they choose to. Every agent above can still be read in full without one.
            </Empty>
          </div>
        ) : (
          <div className="grid-3" style={{ paddingBottom: 22 }}>
            {discoverR.data.slice(0, 6).map((r) => (
              <article key={r.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, lineHeight: 1.1 }}>
                      <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
                    </div>
                    <div className="m2" style={{ fontSize: 11.5 }}>{r.universe ?? 'universe not stated'}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {n(r.arcana_score) === null ? (
                      <><div className="mono m3" style={{ fontSize: 13 }}>not scored</div><Lbl>NO SNAPSHOT</Lbl></>
                    ) : (
                      <><div className="mono" style={{ fontSize: 22, fontWeight: 500, lineHeight: 1 }}>{fmtScore(n(r.arcana_score))}</div><Lbl>LATEST SCORE</Lbl></>
                    )}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 11.5 }}>
                  <div><Lbl>ACCESS</Lbl><div>{r.access_type ?? '—'}</div></div>
                  <div><Lbl>$ARCA GATE</Lbl><div className="mono">{n(r.arca_gate_amount) === null ? <span className="m3">none</span> : money(n(r.arca_gate_amount))}</div></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
                  <div>
                    {n(r.price_usd) === null ? <span className="mono m3" style={{ fontSize: 12 }}>no price</span> : (
                      <><span className="mono" style={{ fontSize: 15 }}>{money(n(r.price_usd))}</span><span className="m3" style={{ fontSize: 11 }}> USD</span></>
                    )}
                  </div>
                  <Link href="/signin?next=%2Fmarketplace" className="btn btn-primary" style={{ padding: '5px 14px', fontSize: 13 }}>Subscribe</Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------- 9 · RECENT ON-CHAIN ACTIVITY */}
      <section className="sec">
        <div className="sec-hd">
          <h2>Recent on-chain activity</h2>
          <span className="mono m3" style={{ fontSize: 11 }}>settled trades across all agents · not decisions</span>
        </div>
        {!execR.ok ? (
          <div style={{ paddingBottom: 24 }}><Failed what="On-chain activity" error={execR} /></div>
        ) : execR.data.items.length === 0 ? (
          <div style={{ paddingBottom: 24 }}><Empty title="No trade has settled yet" /></div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>Time · UTC</th>
                    <th style={{ width: 160 }}>Agent</th>
                    <th style={{ width: 80 }}>Action</th>
                    <th style={{ width: 74 }}>Symbol</th>
                    <th className="r" style={{ width: 100 }}>Qty</th>
                    <th className="r" style={{ width: 96 }}>Price</th>
                    <th className="r" style={{ width: 104 }}>Notional</th>
                    <th className="r" style={{ width: 76 }}>Slip · bps</th>
                    <th className="r" style={{ width: 90 }}>Gas · USD</th>
                    <th style={{ width: 130 }}>Tx</th>
                    <th style={{ width: 110 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {execR.data.items.map((e, i) => (
                    <tr key={`${e.ts}-${i}`} style={e.status !== 'mined' ? { color: 'var(--ink-2)' } : undefined}>
                      <td className="mono m2" style={{ fontSize: 11.5 }}>{utc(e.ts)}</td>
                      <td>
                        <Link href={`/agents/${e.agent_id}`}>{e.agent_name}</Link>
                        {e.version && e.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{e.version}</span> : null}
                      </td>
                      <td>
                        {e.decided_by && e.decided_by.category.startsWith('protective')
                          ? <Tag tone="amber" title={e.decided_by.note}>{e.decided_by.label}</Tag>
                          : <ActionTag action={e.action} />}
                      </td>
                      <td className="mono">{e.symbol ?? '—'}</td>
                      <td className="r"><Num value={num(e.quantity, 6)} /></td>
                      <td className="r"><Num value={money(e.price_usdg)} /></td>
                      <td className="r"><Num value={money(e.notional_usdg)} /></td>
                      <td className="r"><Num value={num(e.slippage_bps, 2)} /></td>
                      <td className="r"><Num value={num(e.gas_cost_usd, 5)} /></td>
                      <td className="mono m3" style={{ fontSize: 11 }} title={e.tx_hash ?? undefined}>
                        {e.tx_hash ? txShort(e.tx_hash) : <span className="m3">—</span>}
                      </td>
                      <td>
                        {e.status === 'mined' ? <Tag tone="accent">MINED</Tag>
                          : e.status === 'reverted' ? <Tag tone="red" title={e.refusal_code ?? undefined}>REVERTED</Tag>
                          : <Tag tone="amber" title={e.refusal_code ?? undefined}>{e.status.toUpperCase()}</Tag>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0 20px', fontSize: 12, gap: 16, flexWrap: 'wrap' }}>
              <span className="m3">
                Blocked and reverted transactions are kept in the record: they cost gas, and a feed that hides them
                would make execution look perfect.
              </span>
              {stats?.chain.last_block_seen ? (
                <span className="mono m3">latest block seen {int(stats.chain.last_block_seen)}</span>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------ 10 · SEASONS */}
      <section className="sec">
        <div className="sec-hd">
          <h2>Seasons</h2>
          <Link href="/seasons" style={{ fontSize: 12.5 }}>All seasons →</Link>
        </div>
        {!seasonsR.ok ? (
          <div style={{ paddingBottom: 24 }}><Failed what="The season list" error={seasonsR} /></div>
        ) : (
          <div className="grid-seasons" style={{ paddingBottom: 22 }}>
            <div className="node" style={{ padding: '16px 18px' }}>
              {running.length === 0 ? (
                <Empty title="No season is running right now" />
              ) : (
                running.slice(0, 1).map((s) => <RunningSeason key={s.id} s={s} board={board} />)
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div className="node" style={{ padding: '14px 16px' }}>
                <div className="k" style={{ marginBottom: 10 }}>Other seasons</div>
                {others.length === 0 ? (
                  <div className="m3" style={{ fontSize: 11.5 }}>there are none</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '7px 12px', fontSize: 12 }}>
                    {others.map((s) => (
                      <div key={s.id} style={{ display: 'contents' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <Link href={`/leaderboard?season_id=${s.id}`}>{s.name}</Link>{' '}
                          <span className="m3">{utcDate(s.startAt)}</span>
                        </span>
                        <span className="mono m2">{s.progress?.status ?? 'unknown'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <PrivateProof />

      <ForCreators
        leadingMandate={
          top && agentR?.ok && agentR.data.mandate
            ? { agent: top.agent_name, text: agentR.data.mandate, score: fmtScore(top.score) }
            : null
        }
      />

      {/* -------------------------------------------- 12 · CHAIN AND TRUST */}
      <section className="sec" style={{ background: 'rgba(228,237,231,.02)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 24, padding: '20px 0' }}>
          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>NETWORK</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '5px 12px', fontSize: 12 }}>
              <span className="m3">chain</span><span className="mono">Robinhood Chain</span>
              <span className="m3">chain id</span><span className="mono">{stats?.chain.id ?? CHAIN}</span>
              <span className="m3">latest block</span><span className="mono">{stats ? int(stats.chain.last_block_seen) : '—'}</span>
              <span className="m3">blocks written</span><span className="mono">{stats ? int(stats.chain.blocks_seen) : '—'}</span>
            </div>
          </div>
          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>RECORD</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '5px 12px', fontSize: 12 }}>
              <span className="m3">decisions</span><span className="mono">{stats ? int(stats.decisions.total) : '—'}</span>
              <span className="m3">settled</span><span className="mono">{stats ? int(stats.executions.settled) : '—'}</span>
              <span className="m3">blocked</span><span className="mono">{stats ? int(stats.executions.blocked) : '—'}</span>
              <span className="m3">reverted</span><span className="mono">{stats ? int(stats.executions.reverted) : '—'}</span>
            </div>
          </div>
          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>SETTLEMENT</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '5px 12px', fontSize: 12 }}>
              <span className="m3">quote token</span><span className="mono">USDG</span>
              <span className="m3">volume</span><span className="mono">{stats ? money(stats.volume.usdg) : '—'}</span>
              <span className="m3">venue</span><span className="mono">Uniswap v3</span>
            </div>
          </div>
          <div style={{ borderLeft: '1px solid var(--color-divider)', paddingLeft: 24 }}>
            <div className="lbl" style={{ marginBottom: 8 }}>VERIFY IT YOURSELF</div>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 }}>
              Every trade above carries its transaction hash. Point your own node at chain {stats?.chain.id ?? CHAIN}{' '}
              and you will read the same fills, the same refusals and the same gas.
            </p>
          </div>
        </div>
      </section>

      <LandingFooter chainId={String(stats?.chain.id ?? CHAIN)} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-cell">
      <Key>{label}</Key>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

/**
 * The season that is running, with the clock drawn from its own dates.
 *
 * The WORD for the state is the backend's — `progress.status` — and is never
 * re-derived here, so the label and the bar cannot disagree about what is
 * running.
 */
function RunningSeason({ s, board }: { s: Season; board: LeaderboardResponse | null }) {
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.max(0, Math.min(1, (Date.now() - start) / (end - start)))
    : null;
  const top3 = (board?.items ?? []).filter((i) => i.ranked).slice(0, 3);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <span className="k">Running now</span>
        <Tag tone="accent" dot>{(s.progress?.status ?? 'running').toUpperCase()}</Tag>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 26 }}>{s.name}</h3>
        <span className="m2" style={{ fontSize: 12.5 }}>
          {utcDate(s.startAt)} → {utcDate(s.endAt)} · {s.universe} · {int(s.progress?.participants)} agents
        </span>
      </div>
      {elapsed !== null ? (
        <>
          <div style={{ margin: '16px 0 8px', position: 'relative', height: 4, background: 'var(--ink-4)' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(elapsed * 100).toFixed(1)}%`, background: 'var(--color-accent)' }} />
          </div>
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ink-3)', gap: 10, flexWrap: 'wrap' }}>
            <span>opened {utcDate(s.startAt)}</span>
            <span className="m2">{(elapsed * 100).toFixed(0)}% elapsed</span>
            <span>{utcDate(s.endAt)}</span>
          </div>
        </>
      ) : null}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--color-divider)', paddingTop: 16 }}>
        <div className="k" style={{ marginBottom: 8 }}>Current top three</div>
        {top3.length === 0 ? (
          <div className="m3" style={{ fontSize: 11.5 }}>no agent in this season is ranked yet</div>
        ) : (
          <table className="table" style={{ fontSize: 12 }}>
            <tbody>
              {top3.map((r) => (
                <tr key={r.agent_id}>
                  <td className="mono up" style={{ width: 28 }}>{r.rank}</td>
                  <td><Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link></td>
                  <td className="m2">{r.creator?.handle ?? '—'}</td>
                  <td className="mono r">{fmtScore(r.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

