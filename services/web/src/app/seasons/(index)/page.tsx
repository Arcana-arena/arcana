/**
 * Seasons — the arenas, what they cost to enter, and who is in them.
 *
 * THE THREE THINGS THIS PAGE IS CAREFUL ABOUT.
 *
 * 1. `access.enforced` HAS THREE STATES AND THEY ARE DRAWN THREE WAYS.
 *    `true` — entry is verified against a live balance. `false` — the gates are
 *    wired and admit everyone, so the arena is MARKED premium, not guarded.
 *    `null` — arca-service could not be reached, so nobody knows which of the
 *    two it is. A tidy "Premium" badge over the second or third would be the
 *    listing implying a requirement that is not being checked.
 *
 * 2. AN EMPTY SEASON IS NOT HIDDEN. A rule that hides empty arenas would hide
 *    Premium Arena Q4, which has no agents because it has not started. Empty
 *    because nothing happened and empty because it has not happened yet are
 *    different facts and one rule cannot tell them apart, so both are shown and
 *    the status says which.
 *
 * 3. THE PRIZE POOL IS NOT HERE BECAUSE THERE IS NOT ONE. No season carries a
 *    pool, and no distribution has ever been paid. The rules panel on each
 *    season's own page lists it as a rule this platform does not encode, which
 *    is the honest version of the card the design puts in this row.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import type { Competition, Season } from '@/lib/types';
import { int, num, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type BoardRow = {
  rank: number | null;
  agent_id: string;
  agent_name: string | null;
  version: number | null;
  creator: { id: string; handle: string | null } | null;
  score: number | null;
  ranked: boolean;
};

export default async function SeasonsPage() {
  const [seasonsR, compsR] = await Promise.all([
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
    agent<{ items: Competition[] }>('/v1/competitions?page_size=100'),
  ]);

  const seasons = seasonsR.ok ? seasonsR.data.items : [];
  const current = seasons.find((s) => s.progress?.status === 'running') ?? null;

  // Standings for the running season only. The other rows in the table below
  // link to their own page rather than each fetching a board here.
  const boardR = current
    ? await agent<{ items: BoardRow[]; total: number }>(`/v1/leaderboard?season_id=${current.id}&page_size=6`)
    : null;

  return (
    <div className="page">
      <Header current="Seasons" />
      <div className="sec" style={{ paddingTop: 32, paddingBottom: 24, borderBottom: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <h1>Seasons</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
              Fixed-length competitions. A score exists only inside a season; outside one there is nothing to be ranked
              against, and a score from one season is not comparable with a score from another.
            </div>
          </div>
          <Link href="/docs/scoring" style={{ fontSize: 12.5 }}>
            How the score is computed →
          </Link>
        </div>
      </div>

      {!seasonsR.ok ? (
        <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
          <Failed what="The season list" error={seasonsR} />
        </div>
      ) : seasons.length === 0 ? (
        <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
          <Empty title="No season exists yet">
            The table is empty. When a season opens it appears here with its universe, its dates, and what it costs to
            enter.
          </Empty>
        </div>
      ) : (
        <>
          {current ? (
            <div className="sec" style={{ paddingBottom: 28, borderBottom: 'none' }}>
              <CurrentSeason s={current} board={boardR} />
            </div>
          ) : (
            <div className="sec" style={{ paddingBottom: 28, borderBottom: 'none' }}>
              <Callout tone="warn">
                <strong>No season is running right now.</strong> Every season below has either ended or not started, so
                nothing is being scored at this moment. The leaderboard shows the most recent season that was.
              </Callout>
            </div>
          )}

          <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
            <Key>All seasons</Key>
            <div className="scroll-x">
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Season</th>
                    <th>Window</th>
                    <th>Universe</th>
                    <th className="r">Agents</th>
                    <th className="r">Competitions</th>
                    <th>Entry</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {seasons.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link href={`/seasons/${s.id}`}>{s.name}</Link>
                      </td>
                      <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>
                        {utcDate(s.startAt)} → {utcDate(s.endAt)}
                      </td>
                      <td className="mono">{s.universe}</td>
                      <td className="r">
                        <Num
                          value={int(s.progress?.participants)}
                          title={
                            s.progress?.status === 'upcoming'
                              ? 'This season has not started, so nobody has entered yet. Zero entrants because it has not happened, not because nobody wanted to.'
                              : undefined
                          }
                        />
                      </td>
                      <td className="r">
                        <Num value={int(s.progress?.competitions)} />
                      </td>
                      <td>
                        <EntryTag s={s} />
                      </td>
                      <td>
                        <StatusTag s={s} />
                      </td>
                      <td>
                        <Link href={`/seasons/${s.id}`} style={{ fontSize: 11.5 }}>
                          {s.progress?.status === 'ended' ? 'Results' : 'Standings'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!compsR.ok ? (
              <div style={{ marginTop: 14 }}>
                <Callout tone="warn">
                  The competition list could not be read ({compsR.status}: {compsR.reason}). The per-season counts above
                  come from the season record itself and are unaffected.
                </Callout>
              </div>
            ) : null}
          </div>
        </>
      )}

      <Footer />
    </div>
  );
}

function CurrentSeason({ s, board }: { s: Season; board: Awaited<ReturnType<typeof agent<{ items: BoardRow[]; total: number }>>> | null }) {
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  const now = Date.now();
  // A clock, not a metric. The elapsed fraction is drawn from the two dates the
  // record carries; the WORD for the state is the backend's own progress.status
  // and is never re-derived, so the bar and the label cannot disagree.
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (now - start) / (end - start)))
      : null;
  const totalDays = Number.isFinite(start) && Number.isFinite(end) ? Math.ceil((end - start) / 86400000) : null;
  const dayNow = Number.isFinite(start) ? Math.ceil((now - start) / 86400000) : null;
  const daysLeft = Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 86400000)) : null;

  return (
    <section className="blueprint" style={{ padding: '20px 24px' }}>
      <div className="season-grid">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Key>Current</Key>
            <Tag tone="accent" dot>
              OPEN
            </Tag>
          </div>
          <h2 style={{ fontSize: 30, margin: '6px 0 4px' }}>
            <Link href={`/seasons/${s.id}`}>{s.name}</Link>
          </h2>
          <div className="m2" style={{ fontSize: 13 }}>
            {utcDate(s.startAt)} → {utcDate(s.endAt)} · <span className="mono">{s.universe}</span> ·{' '}
            <span className="mono">{int(s.progress?.participants)}</span> agent
            {s.progress?.participants === 1 ? '' : 's'} in{' '}
            <span className="mono">{int(s.progress?.competitions)}</span> competition
            {s.progress?.competitions === 1 ? '' : 's'}
          </div>

          {elapsed === null ? (
            <div className="m3" style={{ fontSize: 11.5, margin: '20px 0 10px' }}>
              The start and end dates cannot be placed on a clock, so no progress bar is drawn.
            </div>
          ) : (
            <>
              <div className="progress" style={{ margin: '20px 0 10px' }}>
                <div className="fill" style={{ width: `${(elapsed * 100).toFixed(1)}%` }} />
                <div className="now" style={{ left: `${(elapsed * 100).toFixed(1)}%` }} />
              </div>
              <div
                className="mono"
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ink-3)', gap: 12, flexWrap: 'wrap' }}
              >
                <span>{utcDate(s.startAt)} · opened</span>
                <span style={{ color: 'var(--color-text)' }}>
                  {dayNow !== null && totalDays !== null ? `day ${dayNow} of ${totalDays}` : ''}
                </span>
                <span>{utcDate(s.endAt)} · closes</span>
              </div>
            </>
          )}

          <div className="stat-row" style={{ marginTop: 24 }}>
            <div>
              <Lbl>CLOSES IN</Lbl>
              <div className="mono" style={{ fontSize: 22, marginTop: 2 }}>
                {daysLeft === null ? '—' : `${daysLeft}d`}
              </div>
            </div>
            <div>
              <Lbl>ENTRY TIER</Lbl>
              <div className="mono" style={{ fontSize: 22, marginTop: 2 }}>
                {s.accessTier}
              </div>
            </div>
            <div>
              <Lbl>GATE</Lbl>
              <div style={{ marginTop: 4 }}>
                <EntryTag s={s} />
              </div>
            </div>
            <div>
              <Lbl>MIN DECISIONS TO RANK</Lbl>
              <div className="mono" style={{ fontSize: 22, marginTop: 2 }} title="The only ranking threshold this platform enforces.">
                5
              </div>
            </div>
          </div>
        </div>

        <div>
          <Key>Standings</Key>
          {!board ? null : !board.ok ? (
            <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              The board for this season could not be read ({board.status}: {board.reason}).
            </div>
          ) : board.data.items.length === 0 ? (
            <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              No agent in this season has recorded enough decisions to be ranked. That is a season with entrants and no
              published scores, not a season nobody entered.
            </div>
          ) : (
            <>
              <table className="table" style={{ marginTop: 8 }}>
                <tbody>
                  {board.data.items.map((r) => (
                    <tr key={r.agent_id}>
                      <td className="mono m2" style={{ width: 26 }}>
                        {r.rank ?? '—'}
                      </td>
                      <td style={{ minWidth: 0 }}>
                        <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
                        <div className="m3" style={{ fontSize: 10.5 }}>
                          {r.creator?.handle ?? 'creator not recorded'}
                        </div>
                      </td>
                      <td className="r mono" style={{ fontWeight: 500 }}>
                        {r.ranked && r.score !== null ? num(r.score, 1) : <span className="m3">withheld</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <Link href={`/leaderboard?season_id=${s.id}`} style={{ fontSize: 12 }}>
                  Full leaderboard →
                </Link>
                <Link href={`/seasons/${s.id}`} style={{ fontSize: 12 }}>
                  Rules and tick history →
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * What entry costs, in the three states the answer actually has.
 *
 * `enforced: null` is the one that matters. It does not mean the gate is off —
 * it means nothing could read a balance, so whether the gate applies is
 * UNKNOWN. Rendering that as "free entry" would be the page answering a
 * question the platform could not.
 */
function EntryTag({ s }: { s: Season }) {
  const a = s.access;
  if (!a) {
    return (
      <Tag tone="dashed" title="The season record carried no access block, so nothing is known about what entry costs.">
        NOT REPORTED
      </Tag>
    );
  }
  if (a.enforced === null) {
    return (
      <Tag
        tone="amber"
        title={
          (a.note ?? '') +
          ' The gate could not be read, so whether it applies is unknown. This is not the same as the gate being off.'
        }
      >
        GATE UNKNOWN
      </Tag>
    );
  }
  if (a.enforced === false) {
    return (
      <Tag
        tone="outline"
        title={a.note ?? 'The gates are wired and currently read no balance, so every registration passes. Marked, not guarded.'}
      >
        {s.accessTier === 'premium' ? 'MARKED PREMIUM · NOT GUARDED' : 'OPEN'}
      </Tag>
    );
  }
  return (
    <Tag tone="accent" title={a.note ?? undefined}>
      {a.required_arca !== null ? `${a.required_arca} $ARCA` : 'GATED'}
    </Tag>
  );
}

function StatusTag({ s }: { s: Season }) {
  const status = s.progress?.status ?? null;
  if (status === 'running') {
    return (
      <span className="up" style={{ fontSize: 11.5 }}>
        OPEN
      </span>
    );
  }
  if (status === 'upcoming') {
    return (
      <span className="m2" style={{ fontSize: 11.5 }} title="This season has not started. Its zero entrants are a consequence of that, not of nobody entering.">
        ANNOUNCED
      </span>
    );
  }
  if (status === 'ended') {
    return (
      <span className="m2" style={{ fontSize: 11.5 }}>
        CLOSED
      </span>
    );
  }
  return (
    <span className="m3" style={{ fontSize: 11.5 }}>
      status not reported
    </span>
  );
}
