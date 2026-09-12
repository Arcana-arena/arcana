/**
 * Seasons — the arenas, what they cost to enter, and who is in them.
 *
 * THE THREE THINGS THIS PAGE IS CAREFUL ABOUT.
 *
 * 1. `access.enforced: null` is not "not enforced". It means nothing has read a
 *    balance, so nobody knows whether the gate is applied. A premium tier whose
 *    gate is unverified admits everyone, and printing a tidy "Premium" badge
 *    over that would be the listing implying a requirement that is not being
 *    checked. All three states are rendered differently.
 *
 * 2. Standings are NOT a leaderboard. A competition's standings rank by NAV
 *    inside that competition; the leaderboard ranks by ARCANA Score across the
 *    season. They are different questions with different answers, and this page
 *    labels the column it is showing and links to the other one rather than
 *    quietly presenting one as the other.
 *
 * 3. A season with no participants says "no agent has entered", which is a
 *    fact, instead of drawing an empty table that reads like a loading state.
 *
 * WHAT THE MOCKUP SHOWS THAT IS NOT HERE: prize pool, prize split, and the
 * eligibility pair (14 days / 30 decisions). No endpoint carries a prize pool
 * or a per-season eligibility rule — the only threshold the API publishes is the
 * leaderboard's decision count — so those blocks are absent and named as absent
 * rather than filled with round numbers.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import type { Competition, Season } from '@/lib/types';
import { int, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

export default async function SeasonsPage() {
  const [seasonsR, compsR] = await Promise.all([
    agent<{ items: Season[] }>('/v1/seasons?page_size=50'),
    agent<{ items: Competition[] }>('/v1/competitions?page_size=100'),
  ]);

  return (
    <div className="page">
      <Header current="Seasons" />
      <div className="sec" style={{ paddingTop: 32, paddingBottom: 24, borderBottom: 'none' }}>
        <h1>Seasons</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
          Fixed-length competitions. A score exists only inside a season; outside one there is nothing to be ranked
          against.
        </div>
      </div>

      {!seasonsR.ok ? (
        <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
          <Failed what="The season list" error={seasonsR} />
        </div>
      ) : seasonsR.data.items.length === 0 ? (
        <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
          <Empty title="No seasons exist yet">
            The table is empty. When a season opens it appears here with its universe, its dates and what it costs to
            enter.
          </Empty>
        </div>
      ) : (
        <SeasonList
          seasons={seasonsR.data.items}
          comps={compsR.ok ? compsR.data.items : []}
          compsFailed={compsR.ok ? null : compsR}
        />
      )}

      <Footer note="dates, tiers and counts are read from the season record; nothing here is derived from a guess" />
    </div>
  );
}

function SeasonList({
  seasons,
  comps,
  compsFailed,
}: {
  seasons: Season[];
  comps: Competition[];
  compsFailed: { status: number | null; reason: string } | null;
}) {
  return (
    <div className="sec" style={{ display: 'grid', gap: 28, paddingBottom: 40, borderBottom: 'none' }}>
      {seasons.map((s) => (
        <SeasonCard
          key={s.id}
          s={s}
          comps={comps.filter((c) => (c.seasonId ?? c.season_id) === s.id)}
          compsFailed={compsFailed}
        />
      ))}
    </div>
  );
}

function SeasonCard({
  s,
  comps,
  compsFailed,
}: {
  s: Season;
  comps: Competition[];
  compsFailed: { status: number | null; reason: string } | null;
}) {
  const status = s.progress?.status ?? null;
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  const now = Date.now();
  // A clock, not a metric. The elapsed fraction is drawn from the two dates the
  // record already carries; the WORD for the state comes from the backend's
  // own `progress.status` and is never re-derived here, so the bar and the
  // label cannot disagree about what is running.
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (now - start) / (end - start)))
      : null;

  return (
    <section style={{ border: '1px solid var(--color-divider)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
          padding: '14px 20px',
          borderBottom: '1px solid var(--color-divider)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 24 }}>{s.name}</h2>
          {status === 'running' ? (
            <Tag tone="accent" dot>
              OPEN
            </Tag>
          ) : status === 'upcoming' ? (
            <Tag tone="outline">UPCOMING</Tag>
          ) : status === 'ended' ? (
            <Tag tone="outline">CLOSED</Tag>
          ) : (
            <Tag tone="dashed" title="The season record carried no status.">
              STATUS NOT REPORTED
            </Tag>
          )}
          <span className="mono m2" style={{ fontSize: 11.5 }}>
            {s.universe}
          </span>
        </div>
        <Link href={`/leaderboard?season_id=${s.id}`} style={{ fontSize: 12.5 }}>
          Leaderboard for this season →
        </Link>
      </div>

      {/* minmax(0, 320px), not 320px: a fixed track is a MINIMUM as well as a
          maximum, so anything inside it that refuses to shrink widens the page
          instead of being clipped. Collapses to one column on a narrow screen. */}
      <div
        style={{
          padding: '18px 20px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 320px)',
          gap: 32,
        }}
      >
        <div>
          <div className="mono m2" style={{ fontSize: 12 }}>
            {utcDate(s.startAt)} → {utcDate(s.endAt)}
          </div>

          {elapsed === null ? (
            <div className="m3" style={{ fontSize: 11.5, marginTop: 14 }}>
              the start and end dates cannot be placed on a clock, so no progress bar is drawn
            </div>
          ) : (
            <>
              <div style={{ margin: '18px 0 8px', position: 'relative', height: 4, background: 'var(--ink-4)' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${(elapsed * 100).toFixed(1)}%`,
                    background: 'var(--color-accent)',
                  }}
                />
              </div>
              <div
                className="mono"
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ink-3)' }}
              >
                <span>{utcDate(s.startAt)} · opened</span>
                <span className="m2">{(elapsed * 100).toFixed(0)}% of the window elapsed</span>
                <span>{utcDate(s.endAt)} · closes</span>
              </div>
            </>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 22 }}>
            <div>
              <Key>Competitions</Key>
              <div className="stat-value">
                <Num value={int(s.progress?.competitions)} />
              </div>
            </div>
            <div>
              <Key>Agents entered</Key>
              <div className="stat-value">
                <Num value={int(s.progress?.participants)} />
              </div>
              {s.progress?.participants === 0 ? (
                <div className="m3" style={{ fontSize: 11 }}>
                  no agent has entered — this is a counted zero
                </div>
              ) : null}
            </div>
            <div>
              <Key>Tier</Key>
              <div className="stat-value" style={{ fontSize: 20 }}>
                {s.accessTier}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 22 }}>
            <Key>Competitions in this season</Key>
            {compsFailed ? (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 6 }}>
                the competition list could not be read ({compsFailed.status ?? 'no answer'}: {compsFailed.reason}), so
                none are listed — this is not the same as there being none
              </div>
            ) : comps.length === 0 ? (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 6 }}>
                none yet
              </div>
            ) : (
              <div className="scroll-x">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>Competition</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th className="r">Agents</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {comps.map((c) => (
                      <tr key={c.id}>
                        <td className="mono m2" style={{ fontSize: 11 }}>
                          {c.id.slice(0, 8)}
                        </td>
                        <td>{c.type ? String(c.type).replace(/_/g, ' ') : '—'}</td>
                        <td>
                          {c.status === 'running' ? (
                            <Tag tone="accent" dot>
                              RUNNING
                            </Tag>
                          ) : (
                            <Tag tone="outline">{String(c.status || '—').toUpperCase()}</Tag>
                          )}
                        </td>
                        <td className="r">
                          <Num value={int((c.participantIds ?? c.participant_ids ?? []).length)} />
                        </td>
                        <td>
                          <Link href={`/seasons/${s.id}/competitions/${c.id}`} style={{ fontSize: 12 }}>
                            Standings →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <Access s={s} />
      </div>
    </section>
  );
}

/**
 * What the arena costs, and whether anything checks.
 *
 * enforced === true   → a balance is read, and required_arca is the number.
 * enforced === false  → the gate exists and is deliberately not applied.
 * enforced === null   → NOBODY KNOWS. This is the state that must not be
 *                       rendered as "not enforced", and it is the one a tier
 *                       badge would paper over.
 */
function Access({ s }: { s: Season }) {
  const a = s.access;
  return (
    <div style={{ borderLeft: '1px solid var(--color-divider)', paddingLeft: 20 }}>
      <Key>Entry</Key>
      {!a ? (
        <div className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>
          this season record carries no access block at all
        </div>
      ) : (
        <>
          <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
            <div>
              <div className="lbl">TIER</div>
              <div className="mono" style={{ fontSize: 18 }}>
                {a.tier ?? s.accessTier}
              </div>
            </div>
            <div>
              <div className="lbl">REQUIRED $ARCA</div>
              <div className="mono" style={{ fontSize: 18 }}>
                {a.required_arca === null || a.required_arca === undefined ? (
                  <span className="m3" title="No gate on this season reads a balance, so there is no required amount.">
                    none read
                  </span>
                ) : (
                  <Num value={int(a.required_arca)} />
                )}
              </div>
            </div>
            {/*
              THE BADGE IS ONE WORD AND THE SENTENCE IS UNDERNEATH. A `.tag` is
              `white-space: nowrap` — it has to be, so a status never breaks in
              half — which meant a badge carrying a whole sentence set its own
              minimum width and pushed this 320px column out to 359px, and the
              page scrolled sideways. Caught by the browser pass measuring
              scrollWidth, not by anything that reads HTML.

              It reads better this way too: three states, three words, and the
              distinction that matters spelled out in prose rather than crammed
              into a chip.
            */}
            <div>
              <div className="lbl">IS IT CHECKED?</div>
              <div style={{ marginTop: 4 }}>
                {a.enforced === true ? (
                  <>
                    <Tag tone="accent">ENFORCED</Tag>
                    <div className="m2" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>
                      a balance is read before entry
                    </div>
                  </>
                ) : a.enforced === false ? (
                  <>
                    <Tag tone="amber">NOT ENFORCED</Tag>
                    <div className="m2" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>
                      the gate is declared and is not applied — entry is open
                    </div>
                  </>
                ) : (
                  <>
                    <Tag tone="dashed">UNKNOWN</Tag>
                    <div className="m2" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>
                      nothing has verified this gate, so whether it is applied is not known — which is
                      not the same as knowing it is off
                    </div>
                  </>
                )}
              </div>
            </div>
            {a.gates && a.gates.length > 0 ? (
              <div>
                <div className="lbl">GATES</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {a.gates.map((g, i) => (
                    <Tag key={i} tone="outline">
                      {g.action}
                    </Tag>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          {a.note ? (
            <div style={{ marginTop: 12 }}>
              <Callout tone="note">{a.note}</Callout>
            </div>
          ) : null}
        </>
      )}
      <div style={{ marginTop: 14 }}>
        <Callout tone="note">
          <strong>No prize pool is shown.</strong> The design has one, and so does the eligibility pair beside it. No
          endpoint publishes either, so nothing is printed rather than a plausible round number.
        </Callout>
      </div>
    </div>
  );
}
