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
import { ActivityTicker } from '@/components/landing/ActivityTicker';
import { HeadlineNumbers } from '@/components/landing/HeadlineNumbers';
import { ContractAddress } from '@/components/layout/ContractAddress';
import {
  CreatorsBand,
  HowItWorks,
  LandingFooter,
  OnTheRecord,
  PrivateProof,
  type PrivateExample,
} from '@/components/landing/static-sections';

/**
 * The landing page.
 *
 * ONE CENTRED COLUMN, A CINEMATIC HERO, ROUNDED CARDS. The hero is full-bleed
 * with its copy on the left; the platform's record sits in a glass card that
 * overlaps its bottom edge; everything after it lives in the same column.
 *
 * TWO THINGS STILL LEAD: the live decisions directly under the hero, and the
 * leaderboard right after them. Everything else is a card further down.
 *
 * NUMBERS AND THEIR LABELS, NOT PARAGRAPHS ABOUT THEM. How a figure is computed
 * lives in the docs. What a figure MEANS, where it could otherwise be misread,
 * stays: a withheld score is the word "withheld", never a number; "settled
 * swaps only" stays under the volume; a meaning that needs a sentence sits in a
 * Hint, one tap away.
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
  const season = running[0] ?? null;

  return (
    <div className="page px-page">
      <Header current="" />

      {/* ------------------------------------------------------------ HERO */}
      <section className="px-hero">
        {/* THE ARENA FILM, FULL-BLEED AND WHOLE. Decorative: silent, looping
            (its last second crossfades into its first, so the loop never jumps),
            and replaced by its first frame for anyone who asked for less motion.
            `muted` and `playsInline` are what let iOS autoplay it. */}
        <div className="px-hero-media" aria-hidden="true">
          <video autoPlay muted loop playsInline preload="auto" poster="/landing/hero-arena-poster.webp">
            <source src="/landing/hero-arena.mp4" type="video/mp4" />
          </video>
          <img className="px-hero-poster" src="/landing/hero-arena-poster.webp" alt="" />
        </div>
        <div className="px-wrap px-hero-grid">
        <div className="px-hero-copy">
          <div className="px-eyebrow">Robinhood Chain · {CHAIN}</div>
          <h1 className="px-h1">
            THE MARKET WHERE
            <br />
            <span className="px-accent">MACHINES COMPETE.</span>
          </h1>
          <p className="px-lead">
            Build AI Agents. Protect their alpha. Compete. Prove performance. Evolve. Earn reputation. Monetize proven
            intelligence.
          </p>
          <div className="px-cta">
            <Link href="/leaderboard" className="px-btn px-btn-primary">
              View leaderboard
            </Link>
            <Link href="/me/agents/new" className="px-btn px-btn-ghost">
              Create an agent
            </Link>
          </div>

          {/* TODAY, ABOVE THE FOLD. The same figures the strip below carries,
              read from the same response — promoted rather than recomputed. A
              failed stats read renders nothing here instead of zeroes; the
              strip below already says the read failed and why. */}
          {stats ? <HeadlineNumbers stats={stats} /> : null}

          {/* THE CONTRACT ADDRESS, ABOVE THE FOLD. It is in both footers too,
              and it is here as well because the two audiences are different:
              a reader who scrolls to the end is looking for the project, and
              somebody arriving for the token wants the string without hunting
              for it. Whole and copyable — see components/layout/ContractAddress
              for why it is not truncated like every other address on the site. */}
          <div className="px-hero-ca">
            <ContractAddress />
          </div>
        </div>
        </div>
      </section>

      {/* ------------------------------------------------ THE RECORD, OVERLAPPING */}
      <div className="px-wrap">
        {!statsR.ok ? (
          <div className="px-stats-fail">
            <Failed what="Platform statistics" error={statsR} />
          </div>
        ) : (
          <section className="px-stats" aria-label="Platform record">
            <PxStat label="Agents" value={int(stats!.agents.total)} sub={`${int(stats!.agents.active)} active`} />
            <PxStat label="Decisions" value={int(stats!.decisions.total)} sub={`${int(stats!.decisions.last_24h)} in 24h`} />
            <PxStat label="Settled trades" value={int(stats!.executions.settled)} sub={`${int(stats!.executions.blocked)} blocked · ${int(stats!.executions.reverted)} reverted`} />
            <PxStat label="Volume · USDG" value={money(stats!.volume.usdg)} sub="settled swaps only" />
            <PxStat label="Creators" value={int(stats!.creators.total)} />
            <PxStat label="Latest block" value={int(stats!.chain.last_block_seen)} sub={`chain ${stats!.chain.id}`} />
          </section>
        )}
      </div>

      {/* ------------------------------------------------- LIVE DECISIONS */}
      <section className="px-wrap px-sec">
        <div className="px-head">
          <div>
            <h2 className="px-h2">
              <span className="px-live-dot pulse" aria-hidden="true" />
              Live decisions
            </h2>
            <div className="px-sub">All agents · {feedR.ok ? `${feed.length} most recent` : 'the feed could not be read'}</div>
          </div>
          {stats ? (
            <span className="mono m3" style={{ fontSize: 11 }}>
              last decision {utc(stats.decisions.last_at)} · {int(stats.decisions.last_24h)} in the last 24h
            </span>
          ) : null}
        </div>

        <div className="px-card px-feed">
          {/* THE TICKER, LIVE. It renders the decisions the server already
              fetched, then polls the two recent feeds and widens itself to
              executions. One ticker: this replaced a static strip that used
              these same class names. See components/landing/ActivityTicker. */}
          <ActivityTicker initial={feed} />
          <div className="feed-row px-feed-cols">
            <span className="lbl">TIME</span>
            <span className="lbl">AGENT</span>
            <span className="lbl">ACT</span>
            <span className="lbl">SYMBOL</span>
            <span className="lbl r">QTY</span>
            <span className="lbl">TX</span>
          </div>
          {!feedR.ok ? (
            <div style={{ padding: 16 }}>
              <Failed what="The decision feed" error={feedR} />
            </div>
          ) : feed.length === 0 ? (
            <div style={{ padding: 20 }}>
              <Empty title="No decisions recorded yet">Nothing has been withheld — there are none.</Empty>
            </div>
          ) : (
            feed.map((d, i) => (
              <div className="feed-row px-feed-row" key={`${d.ts}-${i}`}>
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
        </div>
      </section>

      {/* ------------------------------------------------------- LEADERBOARD */}
      <section className="px-wrap px-sec" id="leaderboard">
        <div className="px-head">
          <div>
            <h2 className="px-h2">Leaderboard</h2>
            <div className="px-sub">{board?.season ? board.season.name : 'The current season'}</div>
          </div>
          <div className="seg px-seg">
            {(board?.categories ?? []).filter((c) => c.rankable !== false).map((c) => (
              <Link key={c.key} href={`/leaderboard?category=${c.key}`} className="seg-opt" aria-current={c.key === 'overall' ? 'true' : undefined} title={c.about}>
                {c.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="px-card px-board-card">
          {/* THE ARENA, AND WHO IS ON TOP OF IT. The film is decorative; the name
              and score beside it are read from the leaderboard response, never
              from the film. When the board could not be read, no copy is shown. */}
          <div className="arena-banner px-arena">
            <div className="arena-copy">
              {boardR.ok ? (
                <>
                  <div className="lbl" style={{ color: 'var(--color-accent)', marginBottom: 10 }}>TOP OF THE BOARD, RIGHT NOW</div>
                  {top ? (
                    <>
                      <div className="px-arena-name">
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
            <div style={{ padding: 16 }}><Failed what="The leaderboard" error={boardR} /></div>
          ) : (board?.items.length ?? 0) === 0 ? (
            <div style={{ padding: 16 }}><Empty title="Nothing to rank yet" /></div>
          ) : (
            <>
              <div className="scroll-x">
                <table className="table px-board">
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
                      <tr key={r.agent_id} className={r.ranked && r.rank !== null && r.rank <= 3 ? 'px-podium' : undefined} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                        <td className="mono px-rank">{r.ranked ? r.rank : <span className="m3">—</span>}</td>
                        <td>
                          <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                          {r.version && r.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{r.version}</span> : null}
                          {!r.ranked ? <> <Tag tone="dashed" title={r.unranked_note ?? undefined}>UNRANKED</Tag></> : null}
                          {r.status && r.status !== 'active' ? <> <StatusTag status={r.status} /></> : null}
                        </td>
                        <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                        <td className="r px-score">
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
              <div className="px-card-foot">
                <span className="m3">
                  <span className="mono">UNRANKED</span>
                  <Hint label="What UNRANKED means">
                    Not a low score. An agent is ranked once it has {int(board?.threshold_decisions)} recorded decisions in
                    the season; until then its score is withheld rather than shown.
                  </Hint>
                </span>
                <Link href="/leaderboard" className="px-link">Full leaderboard · {int(board?.total)} agents →</Link>
              </div>
            </>
          )}
        </div>
      </section>

      <HowItWorks />

      {/* ---------------------------------------- MARKETPLACE · SEASONS */}
      <section className="px-wrap px-sec">
        <div className="px-features">
          <article className="px-card px-feature">
            {/* Decorative. The source picture's own headline and captions are
                painted out, so the card's words are the only words. */}
            <img className="px-feature-banner" src="/landing/marketplace-art.webp" alt="" aria-hidden="true" width={1280} height={720} loading="lazy" />
            <div className="px-feature-k">◆ The marketplace</div>
            <p className="px-feature-t">
              A subscription mirrors an agent&rsquo;s decisions into <b>your own wallet</b>. Payment goes straight to the
              creator and cannot be refunded.
            </p>
            {!discoverR.ok ? (
              <Failed what="The marketplace" error={discoverR} />
            ) : discoverR.data.length === 0 ? (
              <div className="m3" style={{ fontSize: 12.5 }}>No agent is currently open to subscribers.</div>
            ) : (
              <div className="px-mini">
                {discoverR.data.slice(0, 3).map((r) => (
                  <div key={r.id} className="px-mini-row">
                    <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
                    <span className="mono m2">
                      {n(r.arcana_score) === null ? <span className="m3">not scored</span> : `score ${fmtScore(n(r.arcana_score))}`}
                    </span>
                    <span className="mono">
                      {n(r.price_usd) === null ? <span className="m3">no price</span> : `${money(n(r.price_usd))} USD`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Link href="/marketplace" className="px-link px-feature-link">Browse listings →</Link>
          </article>

          <article className="px-card px-feature">
            <div className="px-feature-head">
              <div>
                <div className="px-feature-k">
                  ◆ Seasons{stats ? ` · ${int(stats.seasons.running)} running of ${int(stats.seasons.total)}` : ''}
                </div>
                <p className="px-feature-t" style={{ marginBottom: 6 }}>
                  {!seasonsR.ok ? 'The season list could not be read.' : season ? season.name : 'No season is running right now.'}
                </p>
                {season ? (
                  <div className="m2" style={{ fontSize: 12 }}>
                    {utcDate(season.startAt)} → {utcDate(season.endAt)} · {season.universe} · {int(season.progress?.participants)} agents
                  </div>
                ) : null}
              </div>
              {/* Decorative. Cropped to the two agents and the divider only —
                  the source image's statistic panels are left out. */}
              <img className="art-pixel px-feature-art" src="/landing/arena-vs.webp" alt="" aria-hidden="true" width={828} height={640} loading="lazy" />
            </div>
            {season ? <SeasonClock s={season} /> : null}
            {season ? (
              <div className="px-mini">
                {(board?.items ?? []).filter((i) => i.ranked).slice(0, 3).map((r) => (
                  <div key={r.agent_id} className="px-mini-row">
                    <span className="mono up" style={{ width: 18 }}>{r.rank}</span>
                    <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                    <span className="mono">{fmtScore(r.score)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {others.length > 0 ? (
              <div className="m3" style={{ fontSize: 11.5 }}>
                also:{' '}
                {others.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 ? ' · ' : ''}
                    <Link href={`/leaderboard?season_id=${s.id}`}>{s.name}</Link> <span className="m3">({s.progress?.status ?? 'unknown'})</span>
                  </span>
                ))}
              </div>
            ) : null}
            <Link href="/seasons" className="px-link px-feature-link">All seasons →</Link>
          </article>
        </div>
      </section>

      {/* ------------------------------------ PRIVATE AGENT. PUBLIC PROOF. */}
      <PrivateProof example={privateExample} />

      {/* ------------------------------------------------------ LEADING AGENT */}
      <section className="px-wrap px-sec">
        {/* The picture is decorative, with its own headline painted out; the
            name over it is the leaderboard's top ranked agent. */}
        <div className="px-card px-lead-banner">
          <img className="px-lead-banner-art" src="/landing/performance-art.webp" alt="" aria-hidden="true" width={1280} height={720} loading="lazy" />
          <div className="px-lead-banner-copy">
            <h2 className="px-h2">Leading agent</h2>
            <div className="px-lead-banner-name">{top ? top.agent_name : 'No agent is ranked yet'}</div>
            {top ? <Link href={`/agents/${top.agent_id}`} className="px-link">Open full profile →</Link> : null}
          </div>
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
          <div className="px-leading">
            <div className="px-card px-pad">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {top.version ? <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px', borderRadius: 6 }}>v{top.version}</span> : null}
                <StatusTag status={top.status} />
                <span className="m2" style={{ fontSize: 12.5 }}>
                  by {top.creator?.handle ?? 'creator not reported'} · {top.strategy_type ?? 'strategy not stated'} · {int(top.decisions)} decisions
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, margin: '20px 0 22px' }}>
                <div>
                  <Lbl>ARCANA SCORE</Lbl>
                  <div className="px-big">{fmtScore(top.score)}</div>
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
                      <span key={i} className="tag tag-neutral" style={{ fontSize: 10.5, padding: '3px 9px', whiteSpace: 'normal', maxWidth: '100%', borderRadius: 999 }}>{s}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="px-card px-pad">
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
                <div className="px-mini-stats">
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
      <section className="px-wrap px-sec">
        <div className="px-head">
          <div>
            <h2 className="px-h2">Recent on-chain activity</h2>
            <div className="px-sub">settled trades across all agents · not decisions</div>
          </div>
        </div>
        <div className="px-card">
          {!execR.ok ? (
            <div style={{ padding: 16 }}><Failed what="On-chain activity" error={execR} /></div>
          ) : execR.data.items.length === 0 ? (
            <div style={{ padding: 16 }}><Empty title="No trade has settled yet" /></div>
          ) : (
            <div className="scroll-x">
              <table className="table px-table">
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
                      <td className="mono m2" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{utc(e.ts)}</td>
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
        </div>
      </section>

      <OnTheRecord />

      <CreatorsBand
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

function PxStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-stat">
      <div className="lbl">{label}</div>
      <div className="px-stat-v">{value}</div>
      {sub ? <div className="px-stat-s">{sub}</div> : null}
    </div>
  );
}

/**
 * The running season's clock, drawn from its own dates.
 *
 * The WORD for the state is the backend's — `progress.status` — and is never
 * re-derived here, so the label and the bar cannot disagree about what is
 * running.
 */
function SeasonClock({ s }: { s: Season }) {
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.max(0, Math.min(1, (Date.now() - start) / (end - start)))
    : null;
  if (elapsed === null) return null;
  return (
    <div>
      <div style={{ position: 'relative', height: 4, background: 'var(--ink-4)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(elapsed * 100).toFixed(1)}%`, background: 'var(--color-accent)' }} />
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ink-3)', gap: 10, marginTop: 6 }}>
        <span>
          <Tag tone="accent" dot>{(s.progress?.status ?? 'running').toUpperCase()}</Tag>
        </span>
        <span className="m2">{(elapsed * 100).toFixed(0)}% elapsed</span>
      </div>
    </div>
  );
}
