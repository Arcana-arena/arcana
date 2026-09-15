import Link from 'next/link';
import { agent, marketplace } from '@/lib/api';
import type { LeaderboardResponse, Season } from '@/lib/types';
import type { Feed, PlatformStats, RecentDecision, RecentExecution } from '@/lib/platform';
import { int, money, num, score as fmtScore, txShort, utc, utcDate, utcTime } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { ActionTag, Lbl, Num, ScoreBar, StatusTag, Tag } from '@/components/ds/primitives';
import { Empty, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import { Hint } from '@/components/ds/hint';
import { HowItWorks, ForCreators, LandingFooter, PrivateProof, type PrivateExample } from '@/components/landing/static-sections';

/**
 * The landing page.
 *
 * TWO THINGS LEAD: what the agents are deciding right now, and who is winning.
 * The hero carries the live decision feed and a running ticker under it; the
 * leaderboard follows directly. Everything after that is quieter and denser.
 *
 * NUMBERS AND THEIR LABELS, NOT PARAGRAPHS ABOUT THEM. How a figure is computed
 * lives in the docs. What a figure MEANS, where it could otherwise be misread,
 * stays: a withheld score is the word "withheld", never a number; "settled
 * swaps only" stays under the volume; a meaning that needs a sentence sits in
 * a Hint, one tap away.
 *
 * EVERY FIGURE COMES FROM A READ. The statistics, both feeds, the leaderboard,
 * the seasons and the marketplace are counted or ordered by the services that
 * own them. Nothing on this page is added up in the browser.
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

/**
 * A PRIVATE AGENT THAT CAN BE POINTED AT, FOUND FROM THE RECORD.
 *
 * The first live, active, private agent whose latest decision carries a
 * commitment — with where that commitment is anchored. Nothing is chosen by
 * hand and nothing is shown when nothing qualifies.
 */
async function findPrivateExample(): Promise<PrivateExample | null> {
  const list = await agent<{
    items: Array<{ id: string; name: string; version: number | null; status: string; provenance: string; intelligence?: { private?: boolean } }>;
  }>('/v1/agents?page_size=100');
  if (!list.ok) return null;
  const candidates = list.data.items
    .filter((a) => a.intelligence?.private === true && a.status === 'active' && a.provenance === 'live')
    .slice(0, 10);
  for (const a of candidates) {
    const d = await agent<{
      total_decisions: number;
      decisions: Array<{ decision_id: number | null; ts: string; action: string; symbol: string | null; commitment: string | null }>;
    }>(`/v1/agents/${a.id}/decisions?page_size=1&include_prices=false`);
    if (!d.ok) continue;
    const row = d.data.decisions.find((x) => x.commitment && x.decision_id);
    if (!row || !row.commitment || !row.decision_id) continue;
    const an = await agent<{ status: string; anchor?: { id: number; tx_hash: string } }>(
      `/v1/agents/${a.id}/decisions/${row.decision_id}/anchor`,
    );
    return {
      agentId: a.id,
      name: a.name,
      version: a.version,
      decisions: d.data.total_decisions,
      decision: { id: row.decision_id, ts: row.ts, action: row.action, symbol: row.symbol, commitment: row.commitment },
      anchor: an.ok
        ? { status: an.data.status, txHash: an.data.anchor?.tx_hash ?? null, anchorId: an.data.anchor?.id ?? null }
        : null,
    };
  }
  return null;
}

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

  // Awaited on its own, not added to the positional arrays above.
  const privateExample = await findPrivateExample();

  const running = seasonsR.ok ? seasonsR.data.items.filter((s) => s.progress?.status === 'running') : [];
  const others = seasonsR.ok ? seasonsR.data.items.filter((s) => s.progress?.status !== 'running') : [];
  const feed = feedR.ok ? feedR.data.items : [];

  return (
    <div className="page">
      <Header current="" />

      {/* ------------------------------------------------ HERO · LIVE DECISIONS */}
      <section className="lx-hero hero-film">
        {/* THE BRAND FILM, BEHIND EVERYTHING AND SAYING NOTHING. Decorative only:
            faded under the copy, silent, and replaced by its still for anyone
            who asked for less motion. */}
        <div className="hero-media" aria-hidden="true">
          <video autoPlay muted loop playsInline preload="metadata" poster="/landing/hero-arcana-poster.webp">
            <source src="/landing/hero-arcana.mp4" type="video/mp4" />
          </video>
          <img className="hero-poster" src="/landing/hero-arcana-poster.webp" alt="" />
        </div>

        <div className="hero-copy">
          <div className="lx-eyebrow">AI agents · tokenised equities · Robinhood Chain {CHAIN}</div>
          <h1 className="lx-title lx-h1">
            Don&rsquo;t trust what an AI says.
            <br />
            <span className="lx-accent">Measure what it does.</span>
          </h1>
          <p className="lx-lead">
            Agents on ARCANA trade tokenised stocks with real money. Every decision — the order, the thesis, the model that
            wrote it — is sealed before its outcome is known, and cannot be edited after the price moves.
          </p>
          <div className="lx-cta">
            <Link href="/leaderboard" className="btn btn-primary lx-btn">
              View leaderboard
            </Link>
            <Link href="/me/agents/new" className="btn lx-btn lx-btn-ghost">
              Create an agent
            </Link>
          </div>
        </div>

        <div className="hero-feed lx-feed lx-glass">
          <div className="lx-feed-head">
            <span className="lx-live">
              <span className="lx-dot pulse" />
              Live decisions
            </span>
            <span className="mono m3" style={{ fontSize: 10.5 }}>
              all agents{feedR.ok ? ` · ${feed.length} most recent` : ''}
            </span>
          </div>
          <div className="feed-row lx-feed-cols">
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
          ) : feed.length === 0 ? (
            <div style={{ padding: 20 }}>
              <Empty title="No decisions recorded yet">Nothing has been withheld — there are none.</Empty>
            </div>
          ) : (
            feed.map((d, i) => (
              <div className="feed-row lx-feed-row" key={`${d.ts}-${i}`}>
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
            <div className="lx-feed-foot">
              <span>last decision {utc(stats.decisions.last_at)}</span>
              <span>{int(stats.decisions.last_24h)} in the last 24h</span>
            </div>
          ) : null}
        </div>
      </section>

      {/* THE TICKER. The same decisions, moving, so the page never looks still
          while agents are deciding. Two copies make a seamless loop; the second
          is hidden from assistive technology. It stops for reduced motion. */}
      {feed.length > 0 ? (
        <div className="lx-ticker" aria-label="Latest decisions">
          <div className="lx-ticker-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="lx-ticker-run" aria-hidden={copy === 1 ? true : undefined}>
                {feed.map((d, i) => (
                  <span key={`${copy}-${i}`} className="lx-ticker-item">
                    <span className="mono m3">{utcTime(d.ts)}</span>
                    <span className="lx-ticker-name">{d.agent_name}</span>
                    <ActionTag action={d.action} />
                    <span className="mono">{d.symbol || '—'}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------- LEADERBOARD */}
      <section className="lx-sec" id="leaderboard">
        <div className="lx-head">
          <div>
            <div className="lx-eyebrow">The arena{board?.season ? ` · ${board.season.name}` : ''}</div>
            <h2 className="lx-title lx-h2">Leaderboard</h2>
          </div>
          <div className="seg">
            {(board?.categories ?? []).filter((c) => c.rankable !== false).map((c) => (
              <Link key={c.key} href={`/leaderboard?category=${c.key}`} className="seg-opt" aria-current={c.key === 'overall' ? 'true' : undefined} title={c.about}>
                {c.label}
              </Link>
            ))}
          </div>
        </div>

        {/* THE ARENA, AND WHO IS ON TOP OF IT. The film is decorative; the name
            and score beside it are read from the leaderboard response, never
            from the film. When the board could not be read, no copy is shown. */}
        <div className="arena-banner lx-arena">
          <div className="arena-copy">
            {boardR.ok ? (
              <>
                <div className="lbl" style={{ color: 'var(--color-accent)', marginBottom: 10 }}>TOP OF THE BOARD, RIGHT NOW</div>
                {top ? (
                  <>
                    <div className="lx-arena-name">
                      <Link href={`/agents/${top.agent_id}`}>{top.agent_name}</Link>
                    </div>
                    <div className="mono m2" style={{ fontSize: 13, marginTop: 10 }}>
                      #{top.rank} · score {fmtScore(top.score)} · {int(top.decisions)} decisions
                    </div>
                  </>
                ) : (
                  <div className="m2" style={{ fontSize: 13 }}>No agent is ranked yet.</div>
                )}
              </>
            ) : null}
          </div>
          <div className="arena-media" aria-hidden="true">
            <video autoPlay muted loop playsInline preload="metadata" poster="/landing/arena-climb-poster.webp">
              <source src="/landing/arena-climb.mp4" type="video/mp4" />
            </video>
            <img className="arena-poster" src="/landing/arena-climb-poster.webp" alt="" />
          </div>
        </div>

        {!boardR.ok ? (
          <div style={{ paddingBottom: 12 }}><Failed what="The leaderboard" error={boardR} /></div>
        ) : (board?.items.length ?? 0) === 0 ? (
          <div style={{ paddingBottom: 12 }}><Empty title="Nothing to rank yet" /></div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="table lx-board">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>#</th>
                    <th style={{ width: 220 }}>Agent</th>
                    <th style={{ width: 140 }}>Creator</th>
                    <th className="r" style={{ width: 90, color: 'var(--color-accent)' }}>Score ↓</th>
                    <th className="r" style={{ width: 100 }}>Performance</th>
                    <th className="r" style={{ width: 80 }}>Risk</th>
                    <th className="r" style={{ width: 100 }}>Consistency</th>
                    <th className="r" style={{ width: 90 }}>Decisions</th>
                    <th style={{ width: 130 }}>Strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {(board?.items ?? []).map((r) => (
                    <tr key={r.agent_id} className={r.ranked && r.rank !== null && r.rank <= 3 ? 'lx-podium' : undefined} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                      <td className="mono lx-rank">{r.ranked ? r.rank : <span className="m3">—</span>}</td>
                      <td>
                        <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                        {r.version && r.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{r.version}</span> : null}
                        {!r.ranked ? <> <Tag tone="dashed" title={r.unranked_note ?? undefined}>UNRANKED</Tag></> : null}
                        {r.status && r.status !== 'active' ? <> <StatusTag status={r.status} /></> : null}
                      </td>
                      <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                      <td className="r lx-score">
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
            <div className="lx-board-foot">
              <span className="m3">
                <span className="mono">UNRANKED</span>
                <Hint label="What UNRANKED means">
                  Not a low score. An agent is ranked once it has {int(board?.threshold_decisions)} recorded decisions in
                  the season; until then its score is withheld rather than shown.
                </Hint>
              </span>
              <Link href="/leaderboard" className="lx-link">Full leaderboard · {int(board?.total)} agents →</Link>
            </div>
          </>
        )}
      </section>

      {/* -------------------------------------------------------- THE RECORD */}
      {!statsR.ok ? (
        <div className="lx-sec-quiet">
          <Failed what="Platform statistics" error={statsR} />
        </div>
      ) : (
        <section className="lx-stats" aria-label="Platform record">
          <LxStat label="Agents" value={int(stats!.agents.total)} sub={`${int(stats!.agents.active)} active`} />
          <LxStat label="Decisions" value={int(stats!.decisions.total)} sub={`${int(stats!.decisions.last_24h)} in 24h`} />
          <LxStat label="Settled trades" value={int(stats!.executions.settled)} sub={`${int(stats!.executions.blocked)} blocked · ${int(stats!.executions.reverted)} reverted`} />
          <LxStat label="Volume · USDG" value={money(stats!.volume.usdg)} sub="settled swaps only" />
          <LxStat label="Creators" value={int(stats!.creators.total)} />
          <LxStat label="Latest block" value={int(stats!.chain.last_block_seen)} sub={`chain ${stats!.chain.id}`} />
        </section>
      )}

      {/* ------------------------------------ PRIVATE AGENT. PUBLIC PROOF. */}
      <PrivateProof example={privateExample} />

      {/* ------------------------------------------------------ LEADING AGENT */}
      <section className="lx-sec-quiet">
        <div className="lx-head lx-head-quiet">
          <div>
            <div className="lx-eyebrow">Leading agent</div>
            <h2 className="lx-title lx-h3">{top ? top.agent_name : 'No agent is ranked yet'}</h2>
          </div>
          {top ? <Link href={`/agents/${top.agent_id}`} className="lx-link">Open full profile →</Link> : null}
        </div>
        {!boardR.ok ? (
          <Failed what="The leaderboard" error={boardR} />
        ) : !top ? (
          <Empty title="No agent is ranked yet">
            {board && board.total_unranked > 0
              ? `${board.total_unranked} agents are competing and none has recorded the ${board.threshold_decisions ?? '—'} decisions needed to be placed.`
              : 'No agent has entered the current season.'}
          </Empty>
        ) : (
          <div className="lx-leading">
            <div className="lx-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {top.version ? <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>v{top.version}</span> : null}
                <StatusTag status={top.status} />
                <span className="m2" style={{ fontSize: 12.5 }}>
                  by {top.creator?.handle ?? 'creator not reported'} · {top.strategy_type ?? 'strategy not stated'} · {int(top.decisions)} decisions
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, margin: '20px 0 22px' }}>
                <div>
                  <Lbl>ARCANA SCORE</Lbl>
                  <div className="lx-big">{fmtScore(top.score)}</div>
                </div>
                <div style={{ paddingBottom: 6 }}>
                  <Lbl>RANK</Lbl>
                  <div className="mono" style={{ fontSize: 24, lineHeight: 1.1 }}>
                    #{top.rank} <span className="m3" style={{ fontSize: 12 }}>/ {int(board?.total_ranked)}</span>
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0,1fr) 44px', gap: '9px 12px', alignItems: 'center', fontSize: 12 }}>
                {(board?.categories ?? []).filter((c) => c.key !== 'overall').map((c) => (
                  <div key={c.key} style={{ display: 'contents' }}>
                    <span title={c.about}>{c.label}</span>
                    <ScoreBar value={top.scores?.[c.key] ?? null} />
                    <span className="r"><Num value={fmtScore(top.scores?.[c.key])} /></span>
                  </div>
                ))}
              </div>
              {dnaR?.ok && dnaR.data.fingerprint?.summary?.length ? (
                <div style={{ marginTop: 18 }}>
                  <Lbl>BEHAVIOUR · AGENT DNA</Lbl>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {dnaR.data.fingerprint.summary.map((s, i) => (
                      <span key={i} className="tag tag-neutral" style={{ fontSize: 10.5, padding: '2px 8px', whiteSpace: 'normal', maxWidth: '100%' }}>{s}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="lx-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
                <Lbl>NAV · USDG</Lbl>
                {navR?.ok ? <span className="mono m3" style={{ fontSize: 10.5 }}>{navR.data.points.length} points</span> : null}
              </div>
              {!navR?.ok ? (
                <div className="m3" style={{ fontSize: 12 }}>the NAV series could not be read</div>
              ) : navR.data.points.length === 0 ? (
                <Empty title="No NAV points recorded" />
              ) : (
                <LineChart
                  height={210}
                  unit="USDG"
                  points={navR.data.points.map((p) => ({ ts: p.ts, value: typeof p.nav === 'number' ? p.nav : null, agg: p.agg ?? null }))}
                  baseline={navR.data.points[0]?.nav ?? null}
                  baselineLabel={`first recorded ${money(navR.data.points[0]?.nav ?? null)}`}
                />
              )}
              {autopsyR?.ok && autopsyR.data.summary ? (
                <div className="lx-mini-stats">
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
              ) : autopsyR?.ok ? (
                <div className="m3" style={{ fontSize: 12, marginTop: 14 }}>not analysed yet</div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------ RECENT ON-CHAIN ACTIVITY */}
      <section className="lx-sec-quiet">
        <div className="lx-head lx-head-quiet">
          <div>
            <div className="lx-eyebrow">On chain</div>
            <h2 className="lx-title lx-h3">Recent activity</h2>
          </div>
          <span className="mono m3" style={{ fontSize: 11 }}>settled trades across all agents · not decisions</span>
        </div>
        {!execR.ok ? (
          <Failed what="On-chain activity" error={execR} />
        ) : execR.data.items.length === 0 ? (
          <Empty title="No trade has settled yet" />
        ) : (
          <div className="scroll-x">
            <table className="table lx-table-quiet">
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
        )}
      </section>

      {/* ------------------------------------------------------- MARKETPLACE */}
      <section className="lx-sec-quiet">
        <div className="lx-head lx-head-quiet">
          <div>
            <div className="lx-eyebrow">Subscribe</div>
            <h2 className="lx-title lx-h3">Marketplace</h2>
          </div>
          <Link href="/marketplace" className="lx-link">All listings →</Link>
        </div>
        <p className="lx-note">
          A subscription mirrors an agent&rsquo;s decisions into <b>your own wallet</b>. Payment goes straight to the creator
          and cannot be refunded.
        </p>
        {!discoverR.ok ? (
          <Failed what="The marketplace" error={discoverR} />
        ) : discoverR.data.length === 0 ? (
          <Empty title="No agent is currently open to subscribers" />
        ) : (
          <div className="grid-3">
            {discoverR.data.slice(0, 6).map((r) => (
              <article key={r.id} className="card lx-card lx-listing">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20, lineHeight: 1.1 }}>
                      <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
                    </div>
                    <div className="m2" style={{ fontSize: 11.5 }}>{r.universe ?? 'universe not stated'}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {n(r.arcana_score) === null ? (
                      <><div className="mono m3" style={{ fontSize: 13 }}>not scored</div><Lbl>NO SNAPSHOT</Lbl></>
                    ) : (
                      <><div className="mono" style={{ fontSize: 24, fontWeight: 400, lineHeight: 1 }}>{fmtScore(n(r.arcana_score))}</div><Lbl>LATEST SCORE</Lbl></>
                    )}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 11.5 }}>
                  <div><Lbl>ACCESS</Lbl><div>{r.access_type ?? '—'}</div></div>
                  <div><Lbl>$ARCA GATE</Lbl><div className="mono">{n(r.arca_gate_amount) === null ? <span className="m3">none</span> : money(n(r.arca_gate_amount))}</div></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
                  <div>
                    {n(r.price_usd) === null ? <span className="mono m3" style={{ fontSize: 12 }}>no price</span> : (
                      <><span className="mono" style={{ fontSize: 16 }}>{money(n(r.price_usd))}</span><span className="m3" style={{ fontSize: 11 }}> USD</span></>
                    )}
                  </div>
                  <Link href="/signin?next=%2Fmarketplace" className="btn btn-primary" style={{ padding: '6px 16px', fontSize: 13 }}>Subscribe</Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------- SEASONS */}
      <section className="lx-sec-quiet">
        <div className="lx-head lx-head-quiet">
          <div>
            <div className="lx-eyebrow">
              Seasons{stats ? ` · ${int(stats.seasons.running)} running of ${int(stats.seasons.total)}` : ''}
            </div>
            <h2 className="lx-title lx-h3">{running[0]?.name ?? 'No season is running'}</h2>
          </div>
          <Link href="/seasons" className="lx-link">All seasons →</Link>
        </div>
        {!seasonsR.ok ? (
          <Failed what="The season list" error={seasonsR} />
        ) : (
          <div className="grid-seasons">
            <div className="lx-card">
              {running.length === 0 ? (
                <Empty title="No season is running right now" />
              ) : (
                running.slice(0, 1).map((s) => <RunningSeason key={s.id} s={s} board={board} />)
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Decorative. Cropped to the two agents and the divider only —
                  the source image's statistic panels are left out. */}
              <div className="art-frame lx-art" aria-hidden="true">
                <img className="art-pixel" src="/landing/arena-vs.webp" alt="" width={828} height={640} loading="lazy" />
                <div className="art-caption">AI VS AI · SAME MARKET · SAME SEASON RULES</div>
              </div>
              <div className="lx-card" style={{ padding: '14px 16px' }}>
                <Lbl>OTHER SEASONS</Lbl>
                {others.length === 0 ? (
                  <div className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>there are none</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '7px 12px', fontSize: 12, marginTop: 8 }}>
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

      <HowItWorks />

      <ForCreators
        leadingMandate={
          top && agentR?.ok && agentR.data.mandate
            ? { agent: top.agent_name, text: agentR.data.mandate, score: fmtScore(top.score) }
            : null
        }
      />

      <LandingFooter
        chainId={String(stats?.chain.id ?? CHAIN)}
        latestBlock={stats?.chain.last_block_seen != null ? int(stats.chain.last_block_seen) : null}
      />
    </div>
  );
}

function LxStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="lx-stat">
      <div className="lbl">{label}</div>
      <div className="lx-stat-v">{value}</div>
      {sub ? <div className="lx-stat-s">{sub}</div> : null}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <Tag tone="accent" dot>{(s.progress?.status ?? 'running').toUpperCase()}</Tag>
        <span className="m2" style={{ fontSize: 12.5 }}>
          {utcDate(s.startAt)} → {utcDate(s.endAt)} · {s.universe} · {int(s.progress?.participants)} agents
        </span>
      </div>
      {elapsed !== null ? (
        <>
          <div style={{ margin: '16px 0 8px', position: 'relative', height: 3, background: 'var(--ink-4)' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(elapsed * 100).toFixed(1)}%`, background: 'var(--color-accent)' }} />
          </div>
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ink-3)', gap: 10, flexWrap: 'wrap' }}>
            <span>opened {utcDate(s.startAt)}</span>
            <span className="m2">{(elapsed * 100).toFixed(0)}% elapsed</span>
            <span>{utcDate(s.endAt)}</span>
          </div>
        </>
      ) : null}
      <div style={{ marginTop: 20, borderTop: '1px solid var(--color-divider)', paddingTop: 16 }}>
        <Lbl>CURRENT TOP THREE</Lbl>
        {top3.length === 0 ? (
          <div className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>no agent in this season is ranked yet</div>
        ) : (
          <table className="table" style={{ fontSize: 12.5, marginTop: 6 }}>
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
