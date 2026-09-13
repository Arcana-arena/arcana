/**
 * The leaderboard.
 *
 * NOTHING ON THIS PAGE IS SORTED, RANKED OR AGGREGATED HERE. The rows arrive in
 * the order the database put them in, each carrying the rank the SQL window
 * gave it. Return, drawdown, age and the sparkline arrive from a second read
 * that aggregates them in SQL, joined by agent_id. Switching category, filtering
 * and searching are all LINKS that re-ask the backend — a second ordering in the
 * browser would be a second definition of "best", and the two would agree right
 * up until they did not.
 *
 * THE TWO READS RESOLVE THE SAME SEASON. Both go through resolveSeasonId on the
 * service, so the ranks and the returns are always from one season. Two
 * resolutions of "which season" is how a page ends up showing one season's ranks
 * beside another season's returns and calling it a row.
 */
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import type { LeaderboardResponse, Season } from '@/lib/types';
import { int, num, pct, score as fmtScore, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { Pager, Seg } from '@/components/ds/nav';
import { Sparkline } from '@/components/ds/chart';

export const dynamic = 'force-dynamic';

type SeriesItem = {
  agent_id: string;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  age_days: number | null;
  first_nav: number | null;
  last_nav: number | null;
  points: number;
  series: Array<{ ts: string; nav: number; agg: string }>;
};
type SeriesResponse = { season_id: string; buckets: number; basis: string; items: SeriesItem[] };

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SCORE_BANDS = [
  { key: '', label: 'Any score' },
  { key: '80', label: '≥ 80' },
  { key: '60', label: '≥ 60' },
  { key: '40', label: '≥ 40' },
];

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const category = one(sp.category) || 'overall';
  const seasonId = one(sp.season_id) || '';
  const page = one(sp.page) || '1';
  const pageSize = one(sp.page_size) || '25';
  const includeUnranked = one(sp.include_unranked) === 'true';
  const q = one(sp.q) || '';
  const universe = one(sp.universe) || '';
  const status = one(sp.status) || '';
  const minScore = one(sp.min_score) || '';

  const query = {
    category,
    season_id: seasonId || undefined,
    page,
    page_size: pageSize,
    include_unranked: includeUnranked ? 'true' : undefined,
    q: q || undefined,
    universe: universe || undefined,
    status: status || undefined,
    min_score: minScore || undefined,
  };

  const [board, seasons, series] = await Promise.all([
    agent<LeaderboardResponse & { facets?: { universes: string[]; statuses: string[] } }>(
      `/v1/leaderboard${qs(query)}`,
    ),
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
    agent<SeriesResponse>(`/v1/leaderboard/series${qs({ season_id: seasonId || undefined, buckets: '12' })}`),
  ]);

  const href = (over: Record<string, string | undefined>) => `/leaderboard${qs({ ...query, ...over })}`;

  const bySeries = new Map<string, SeriesItem>();
  if (series.ok) for (const i of series.data.items) bySeries.set(i.agent_id, i);

  return (
    <div className="page">
      <Header current="Leaderboard" />
      {!board.ok ? (
        <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
          <Failed what="The leaderboard" error={board} />
        </div>
      ) : (
        <>
          <div
            className="sec"
            style={{ paddingTop: 32, paddingBottom: 0, borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}
          >
            <div>
              <h1>Leaderboard</h1>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4 }}>
                {board.data.season ? board.data.season.name : 'no season'} ·{' '}
                <span className="mono">{int(board.data.total_ranked)}</span> ranked
                {board.data.total_unranked > 0 ? (
                  <> · <span className="mono">{int(board.data.total_unranked)}</span> competing, not yet ranked</>
                ) : null}
              </div>
            </div>

            {/* A GET form, so a search has a URL and the backend does the matching. */}
            <form action="/leaderboard" method="get" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="hidden" name="category" value={category} />
              {seasonId ? <input type="hidden" name="season_id" value={seasonId} /> : null}
              {includeUnranked ? <input type="hidden" name="include_unranked" value="true" /> : null}
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search agent or creator"
                aria-label="Search agent or creator"
                style={{
                  width: 240,
                  padding: '6px 10px',
                  background: 'transparent',
                  border: '1px solid var(--color-divider)',
                  color: 'var(--color-text)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 12.5,
                }}
              />
              <button className="btn" style={{ padding: '6px 12px', fontSize: 12.5 }} type="submit">
                Search
              </button>
            </form>
          </div>

          {/* -------------------------------------------------------- chips */}
          <div className="sec" style={{ paddingTop: 16, paddingBottom: 14, borderBottom: 'none', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Seg
              current={board.data.category}
              tabs={(board.data.categories ?? []).filter((c) => c.rankable !== false).map((c) => ({
                key: c.key,
                label: c.label,
                href: href({ category: c.key, page: '1' }),
                about: c.about,
              }))}
            />

            <Chip
              label="Season"
              value={board.data.season?.name?.replace(/ - .*/, '') ?? 'all'}
              options={(seasons.ok ? seasons.data.items : []).map((s) => ({
                label: s.name.replace(/ - .*/, ''),
                href: href({ season_id: s.id, page: '1' }),
                active: s.id === board.data.season?.id,
              }))}
            />
            <Chip
              label="Universe"
              value={universe || 'all'}
              active={Boolean(universe)}
              clearHref={universe ? href({ universe: undefined, page: '1' }) : undefined}
              options={(board.data.facets?.universes ?? []).map((u) => ({
                label: u,
                href: href({ universe: u, page: '1' }),
                active: u === universe,
              }))}
            />
            <Chip
              label="Status"
              value={status || 'all'}
              active={Boolean(status)}
              clearHref={status ? href({ status: undefined, page: '1' }) : undefined}
              options={(board.data.facets?.statuses ?? []).map((s) => ({
                label: s,
                href: href({ status: s, page: '1' }),
                active: s === status,
              }))}
            />
            <Chip
              label="Score"
              value={minScore ? `≥ ${minScore}` : 'any'}
              active={Boolean(minScore)}
              clearHref={minScore ? href({ min_score: undefined, page: '1' }) : undefined}
              options={SCORE_BANDS.map((b) => ({
                label: b.label,
                href: href({ min_score: b.key || undefined, page: '1' }),
                active: b.key === minScore,
              }))}
            />

            <Link href={href({ include_unranked: includeUnranked ? undefined : 'true', page: '1' })} className="btn" style={{ fontSize: 12, padding: '4px 10px' }}>
              {includeUnranked ? 'Hide unranked' : 'Show unranked'}
            </Link>
            {q || universe || status || minScore ? (
              <Link href={`/leaderboard${qs({ category, season_id: seasonId || undefined })}`} className="m3" style={{ fontSize: 12 }}>
                Clear
              </Link>
            ) : null}
          </div>

          {/* -------------------------------------------------------- table */}
          <div className="sec" style={{ borderBottom: 'none' }}>
            {board.data.items.length === 0 ? (
              <Empty title="No agent matches this view">
                {q || universe || status || minScore
                  ? 'The filters are narrower than the field. Clearing one of them will widen it.'
                  : includeUnranked
                    ? 'This season holds no agents at all — not even unranked ones.'
                    : `No agent in this season is ranked yet. Ranking needs at least ${board.data.threshold_decisions ?? '—'} recorded decisions.`}
              </Empty>
            ) : (
              <>
                <div className="scroll-x">
                  <table className="table lb-table">
                    <thead>
                      <tr>
                        <th style={{ width: 44 }}>#</th>
                        <th style={{ width: 200 }}>Agent</th>
                        <th style={{ width: 130 }}>Creator</th>
                        <th className="r" style={{ width: 90, color: 'var(--color-accent)' }}>
                          {board.data.categories?.find((c) => c.key === board.data.category)?.label ?? board.data.category} ↓
                        </th>
                        <th className="r" style={{ width: 100 }}>Return</th>
                        <th className="r" style={{ width: 100 }}>Max DD</th>
                        <th style={{ width: 120 }}>Strategy</th>
                        <th className="r" style={{ width: 70 }}>Age</th>
                        <th style={{ width: 140 }}>Season NAV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.data.items.map((r) => {
                        const s = bySeries.get(r.agent_id);
                        return (
                          <tr key={r.agent_id} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                            <td className="mono m2">{r.ranked ? r.rank : <span className="m3">—</span>}</td>
                            <td style={{ position: 'relative' }} className="lb-agent">
                              <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>
                              {r.version && r.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{r.version}</span> : null}
                              {!r.ranked ? <> <Tag tone="dashed" title={r.unranked_note ?? undefined}>UNRANKED</Tag></> : null}
                              {r.status && r.status !== 'active' ? <> <StatusTag status={r.status} /></> : null}

                              {/* Revealed on hover by CSS alone — no client
                                  JavaScript, and every value in it already
                                  arrived with the row. */}
                              <div className="lb-card">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                                  <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 16 }}>{r.agent_name}</span>
                                  <span className="mono m3" style={{ fontSize: 10 }}>
                                    {r.ranked ? `rank ${r.rank}` : 'unranked'} · {r.status ?? '—'}
                                  </span>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                                  <div><div className="lbl">DECISIONS</div>{int(r.decisions)}</div>
                                  <div><div className="lbl">RETURN</div>{s ? pct(s.return_pct) : '—'}</div>
                                  <div><div className="lbl">MAX DD</div>{s ? num(s.max_drawdown_pct, 2) : '—'}</div>
                                  <div><div className="lbl">NAV</div>{s ? num(s.last_nav, 0) : '—'}</div>
                                </div>
                                {!r.ranked && r.unranked_note ? (
                                  <div className="m2" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>{r.unranked_note}</div>
                                ) : null}
                                <div className="mono m3" style={{ fontSize: 10, marginTop: 8 }}>
                                  scored {utc(r.as_of)} · click to open
                                </div>
                              </div>
                            </td>
                            <td className="m2">{r.creator?.handle ?? <span className="m3">—</span>}</td>
                            <td className="r">
                              {r.ranked ? <Num value={fmtScore(r.score)} /> : <span className="mono m3" title={r.unranked_note ?? undefined}>withheld</span>}
                            </td>
                            <td className="r">
                              <Num value={s ? pct(s.return_pct) : '—'} tone={(s?.return_pct ?? 0) > 0 ? 'up' : (s?.return_pct ?? 0) < 0 ? 'dn' : 'flat'} />
                            </td>
                            <td className="r">
                              {s?.max_drawdown_pct === null || s === undefined ? (
                                <span className="mono m3" title="No NAV snapshots in this season, so no drawdown can be measured.">—</span>
                              ) : (
                                // A drawdown of zero is zero, not minus zero.
                                // The sign belongs to a fall that happened.
                                <Num
                                  value={s.max_drawdown_pct === 0 ? '0.00%' : `−${num(s.max_drawdown_pct, 2)}%`}
                                  tone={s.max_drawdown_pct === 0 ? 'flat' : 'dn'}
                                />
                              )}
                            </td>
                            <td><span className="tag tag-neutral">{r.strategy_type ?? '—'}</span></td>
                            <td className="r mono m2">{s?.age_days === null || s === undefined ? <span className="m3">—</span> : `${num(s.age_days, 1)}d`}</td>
                            <td>
                              {s && s.series.length > 1 ? (
                                <Sparkline points={s.series.map((p) => ({ ts: p.ts, value: p.nav }))} width={130} />
                              ) : (
                                <span className="mono m3" style={{ fontSize: 10 }} title="Fewer than two NAV snapshots in this season.">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <Pager
                  page={Number(page) || 1}
                  pageSize={Number(pageSize) || 25}
                  total={board.data.total}
                  hasMore={board.data.has_more}
                  unit="agents"
                  hrefFor={(p) => href({ page: String(Math.max(1, p)) })}
                />
              </>
            )}
          </div>

          <div className="sec" style={{ paddingTop: 0, paddingBottom: 28, borderBottom: 'none', display: 'grid', gap: 12 }}>
            <Callout tone="note">
              <span className="mono">UNRANKED</span> is not a low score. Ranking needs at least{' '}
              <span className="mono">{int(board.data.threshold_decisions)}</span> recorded decisions in the season, and
              no score is published before that.
            </Callout>
            {series.ok ? <Callout tone="note">{series.data.basis}</Callout> : null}
            {board.data.regime_note ? (
              <Callout tone="warn">
                <strong>Regime is not offered as a category.</strong> {board.data.regime_note}
              </Callout>
            ) : null}
          </div>
        </>
      )}
      {/*
        NOT "read at". This is score_snapshots.ts — when the scoring engine last
        wrote these numbers — and it is stable between refreshes because the
        scores are, not because the page is cached. Printed under "read at" it
        told a reader the opposite.
      */}
      <Footer
        stamp={
          board.ok && board.data.items[0]?.as_of
            ? { label: 'scores computed', value: utc(board.data.items[0].as_of) }
            : null
        }
      />
    </div>
  );
}

/**
 * A filter chip with its options underneath.
 *
 * CSS-only, like the row card: the options are always in the document and are
 * revealed on hover or focus. A dropdown that needs JavaScript is a dropdown
 * that does not work on a page which is otherwise entirely server-rendered.
 */
function Chip({
  label,
  value,
  options,
  active,
  clearHref,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; href: string; active: boolean }>;
  active?: boolean;
  clearHref?: string;
}) {
  return (
    <span className="chip" tabIndex={0}>
      <span className="chip-face" style={active ? { borderColor: 'var(--color-accent)' } : undefined}>
        <span className="m2">{label}</span>
        <span style={{ color: 'var(--color-text)' }}>{value}</span>
        {clearHref ? (
          <Link href={clearHref} className="m3" aria-label={`Clear ${label} filter`} style={{ marginLeft: 2 }}>
            ✕
          </Link>
        ) : (
          <span className="m3">▾</span>
        )}
      </span>
      {options.length > 0 ? (
        <span className="chip-menu">
          {options.map((o) => (
            <Link key={o.href} href={o.href} className="chip-opt" aria-current={o.active ? 'true' : undefined}>
              {o.label}
            </Link>
          ))}
        </span>
      ) : null}
    </span>
  );
}
