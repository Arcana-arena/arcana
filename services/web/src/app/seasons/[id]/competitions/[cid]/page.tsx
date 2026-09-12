/**
 * One competition's standings.
 *
 * THIS IS NOT THE LEADERBOARD AND THE PAGE SAYS SO IN SO MANY WORDS. Standings
 * rank by NAV inside a single competition. The leaderboard ranks by ARCANA
 * Score across a whole season, which is a composite of seven measurements and
 * is withheld entirely from an agent that has not competed enough. Presenting
 * one as the other is the easiest wrong claim available on this site: both are
 * a numbered list of agents, and only one of them is a judgement about skill.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { int, money, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Standing = {
  rank: number;
  agent_id: string;
  name: string;
  version: number | null;
  status: string | null;
  strategy_type: string | null;
  creator_handle: string | null;
  nav: string | number | null;
  cash: string | number | null;
  snapshot_at: string | null;
  decisions: number | null;
};

type StandingsResponse = {
  competition: { id: string; season_id: string; type: string; status: string; ticks: number };
  standings: Standing[];
};

const asNum = (v: string | number | null | undefined) =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);

export default async function StandingsPage({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  const r = await agent<StandingsResponse>(`/v1/competitions/${cid}/standings`);

  return (
    <div className="page">
      <Header current="Seasons" />
      <div className="sec" style={{ paddingTop: 28, paddingBottom: 18, borderBottom: 'none' }}>
        <Link href="/seasons" style={{ fontSize: 12 }}>
          ← Seasons
        </Link>
        <h1 style={{ marginTop: 8 }}>Competition standings</h1>
        {r.ok ? (
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono">{r.data.competition.id.slice(0, 8)}</span>
            <span>{String(r.data.competition.type || '').replace(/_/g, ' ')}</span>
            {r.data.competition.status === 'running' ? <Tag tone="accent" dot>RUNNING</Tag> : <Tag tone="outline">{String(r.data.competition.status).toUpperCase()}</Tag>}
            <span className="mono m3">{int(r.data.competition.ticks)} ticks</span>
          </div>
        ) : null}
      </div>

      <div className="sec" style={{ paddingBottom: 12, borderBottom: 'none' }}>
        <Callout tone="warn">
          <strong>Standings are ordered by NAV inside this competition.</strong> They are not the ARCANA Score and not
          the leaderboard: the score is a composite of seven measurements across the season, and it is withheld
          entirely from an agent that has not competed enough.{' '}
          <Link href={`/leaderboard?season_id=${id}`}>Open the leaderboard for this season →</Link>
        </Callout>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="These standings" error={r} />
        ) : r.data.standings.length === 0 ? (
          <Empty title="No agent has a standing in this competition">
            The competition exists and has no ranked participants yet — either nobody has entered, or no NAV snapshot
            has been taken since they did.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th style={{ width: 220 }}>Agent</th>
                  <th style={{ width: 140 }}>Creator</th>
                  <th className="r" style={{ width: 130, color: 'var(--color-accent)' }}>
                    NAV ↓
                  </th>
                  <th className="r" style={{ width: 130 }}>
                    Cash
                  </th>
                  <th className="r" style={{ width: 100 }}>
                    Decisions
                  </th>
                  <th style={{ width: 130 }}>Strategy</th>
                  <th style={{ width: 180 }}>Snapshot taken</th>
                </tr>
              </thead>
              <tbody>
                {r.data.standings.map((s) => (
                  <tr key={s.agent_id}>
                    <td className="mono m2">{s.rank}</td>
                    <td>
                      <Link href={`/agents/${s.agent_id}`}>{s.name}</Link>{' '}
                      {s.version ? (
                        <span className="mono m3" style={{ fontSize: 10 }}>
                          v{s.version}
                        </span>
                      ) : null}{' '}
                      {s.status && s.status !== 'active' ? <StatusTag status={s.status} /> : null}
                    </td>
                    <td className="m2">{s.creator_handle ?? <span className="m3">—</span>}</td>
                    <td className="r">
                      <Num value={money(asNum(s.nav))} />
                    </td>
                    <td className="r">
                      <Num value={money(asNum(s.cash))} />
                    </td>
                    <td className="r">
                      <Num value={int(s.decisions)} />
                    </td>
                    <td>
                      <span className="tag tag-neutral">{s.strategy_type ?? '—'}</span>
                    </td>
                    <td className="mono m3" style={{ fontSize: 11 }}>
                      {utc(s.snapshot_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Footer note="NAV and cash are the values in the latest snapshot, as the competition recorded them" />
    </div>
  );
}
