/**
 * The leaderboard.
 *
 * NOTHING ON THIS PAGE IS SORTED OR RANKED HERE. The rows arrive in the order
 * the database put them in, each carrying the rank the SQL window gave it, and
 * they are printed in the order they arrived. Switching category is a link that
 * re-asks the backend, not a client-side re-sort — a second ordering in the
 * browser would be a second definition of "best", and the two would agree right
 * up until they did not.
 *
 * FOUR COLUMNS FROM THE MOCKUP ARE MISSING AND SAY SO. The design shows Return,
 * Max DD, Age and a 30-day sparkline per row. The leaderboard response carries
 * none of them — they are per-agent series, not season standings — so rather
 * than fetch 25 agents' histories on every page view (or worse, print something
 * plausible) the table prints the seven sub-scores it really has and names the
 * four it does not.
 */
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import type { LeaderboardResponse, Season } from '@/lib/types';
import { int, score as fmtScore, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { Pager, Seg } from '@/components/ds/nav';

export const dynamic = 'force-dynamic';

const SUB_ORDER = ['performance', 'risk', 'consistency', 'strategy', 'longevity', 'creator'] as const;

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const category = one(sp.category) || 'overall';
  const seasonId = one(sp.season_id) || '';
  const page = one(sp.page) || '1';
  const pageSize = one(sp.page_size) || '25';
  const includeUnranked = one(sp.include_unranked) === 'true';

  const [board, seasons] = await Promise.all([
    agent<LeaderboardResponse>(
      `/v1/leaderboard${qs({
        category,
        season_id: seasonId || undefined,
        page,
        page_size: pageSize,
        include_unranked: includeUnranked ? 'true' : undefined,
      })}`,
    ),
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
  ]);

  const href = (over: Record<string, string | undefined>) =>
    `/leaderboard${qs({
      category,
      season_id: seasonId || undefined,
      page,
      page_size: pageSize,
      include_unranked: includeUnranked ? 'true' : undefined,
      ...over,
    })}`;

  return (
    <div className="page">
      <Header current="Leaderboard" />
      {!board.ok ? (
        <div className="sec" style={{ padding: '48px 32px' }}>
          <Failed what="The leaderboard" error={board} />
        </div>
      ) : (
        <LeaderboardBody
          b={board.data}
          seasons={seasons.ok ? seasons.data.items : []}
          seasonsFailed={!seasons.ok}
          category={category}
          includeUnranked={includeUnranked}
          pageNum={Number(page) || 1}
          pageSizeNum={Number(pageSize) || 25}
          href={href}
        />
      )}
      <Footer asOf={board.ok ? utc(board.data.items[0]?.as_of ?? null) : null} />
    </div>
  );
}

function LeaderboardBody({
  b,
  seasons,
  seasonsFailed,
  category,
  includeUnranked,
  pageNum,
  pageSizeNum,
  href,
}: {
  b: LeaderboardResponse;
  seasons: Season[];
  seasonsFailed: boolean;
  category: string;
  includeUnranked: boolean;
  pageNum: number;
  pageSizeNum: number;
  href: (over: Record<string, string | undefined>) => string;
}) {
  const cats = b.categories ?? [];
  const activeCat = cats.find((c) => c.key === b.category);

  return (
    <>
      <div
        className="sec"
        style={{ paddingTop: 32, paddingBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap', borderBottom: 'none' }}
      >
        <div>
          <h1>Leaderboard</h1>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4 }}>
            {b.season ? b.season.name : 'no season'} ·{' '}
            <span className="mono">{int(b.total_ranked)}</span> ranked
            {b.total_unranked > 0 ? (
              <>
                {' '}
                · <span className="mono">{int(b.total_unranked)}</span> competing but not yet ranked
              </>
            ) : null}
            {' '}· ranks are computed in the database, not in this page
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
          {seasonsFailed ? (
            <span className="m3" title="The season list could not be read, so this filter cannot be offered.">
              season filter unavailable
            </span>
          ) : (
            <Seg
              current={b.season?.id ?? ''}
              tabs={seasons.map((s) => ({
                key: s.id,
                label: s.name.replace(/^Season /, 'S').replace(/ - .*/, ''),
                href: href({ season_id: s.id, page: '1' }),
                about: `${s.name} · ${s.progress?.status ?? 'status unknown'}`,
              }))}
            />
          )}
          <Link
            href={href({ include_unranked: includeUnranked ? undefined : 'true', page: '1' })}
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {includeUnranked ? 'Hide unranked' : 'Show unranked'}
          </Link>
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 20, paddingBottom: 14, borderBottom: 'none' }}>
        <Seg
          current={b.category}
          tabs={cats.map((c) => ({ key: c.key, label: c.label, href: href({ category: c.key, page: '1' }), about: c.about }))}
        />
        {activeCat ? (
          <div className="m2" style={{ fontSize: 12, marginTop: 8, maxWidth: 820, lineHeight: 1.5 }}>
            {activeCat.about}
          </div>
        ) : null}
      </div>

      <div className="sec" style={{ borderBottom: 'none' }}>
        {b.items.length === 0 ? (
          <Empty title="No agents match this view">
            {includeUnranked
              ? 'This season has no agents at all in the leaderboard table — not even unranked ones.'
              : `No agent in this season is ranked yet. Ranking needs at least ${b.threshold_decisions ?? '—'} recorded decisions; use "Show unranked" to see the agents that are competing but have not reached it.`}
          </Empty>
        ) : (
          <>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>#</th>
                    <th style={{ width: 220 }}>Agent</th>
                    <th style={{ width: 140 }}>Creator</th>
                    <th className="r" style={{ width: 90, color: 'var(--color-accent)' }}>
                      {activeCat?.label ?? b.category} ↓
                    </th>
                    {SUB_ORDER.filter((k) => k !== b.category).map((k) => (
                      <th key={k} className="r" style={{ width: 88 }} title={cats.find((c) => c.key === k)?.about}>
                        {cats.find((c) => c.key === k)?.label ?? k}
                      </th>
                    ))}
                    <th className="r" style={{ width: 90 }} title="Decisions counted toward ranking — artefact rows are excluded by the backend.">
                      Decisions
                    </th>
                    <th style={{ width: 120 }}>Strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {b.items.map((r) => (
                    <tr key={r.agent_id} style={r.ranked ? undefined : { color: 'var(--ink-2)' }}>
                      <td className="mono m2">
                        {r.ranked ? (
                          r.rank
                        ) : (
                          <span className="m3" title="Not ranked — see the tag beside the name.">
                            —
                          </span>
                        )}
                      </td>
                      <td>
                        <Link href={`/agents/${r.agent_id}`}>{r.agent_name}</Link>{' '}
                        {r.version ? (
                          <span className="mono m3" style={{ fontSize: 10 }}>
                            v{r.version}
                          </span>
                        ) : null}{' '}
                        {r.status && r.status !== 'active' ? <StatusTag status={r.status} /> : null}
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
                          <Num value={fmtScore(r.score)} className="" />
                        ) : (
                          <span
                            className="mono m3"
                            title={
                              r.unranked_note ??
                              'No score is published for an agent that has not competed enough. This is a withheld score, not a low one.'
                            }
                          >
                            withheld
                          </span>
                        )}
                      </td>
                      {SUB_ORDER.filter((k) => k !== b.category).map((k) => (
                        <td key={k} className="r">
                          <Num value={fmtScore(r.scores?.[k])} />
                        </td>
                      ))}
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

            <Pager
              page={pageNum}
              pageSize={pageSizeNum}
              total={b.total}
              totalPages={b.total_pages}
              unit="agents"
              hrefFor={(p) => href({ page: String(Math.max(1, p)) })}
            />
          </>
        )}
      </div>

      <div className="sec" style={{ paddingTop: 0, paddingBottom: 28, borderBottom: 'none', display: 'grid', gap: 12 }}>
        {b.note ? <Callout tone="note">{b.note}</Callout> : null}
        {b.regime_note ? (
          <Callout tone="warn">
            <strong>Regime is not offered as a category.</strong> {b.regime_note}
          </Callout>
        ) : null}
        <Callout tone="note">
          <strong>Four columns in the design are not on this table.</strong> Return, max drawdown, age and the
          30-day sparkline are per-agent history, and the leaderboard response does not carry them. They are on each
          agent&rsquo;s own page, read from that agent&rsquo;s series. Nothing is printed here that this response did not
          contain.
        </Callout>
      </div>
      <div style={{ height: 24 }} />
    </>
  );
}
