/**
 * A creator, and the agents they are responsible for.
 *
 * WHY THIS PAGE EXISTS NOW. The marketplace grid and every listing page name a
 * creator and link to them. Linking somewhere that answers 404 is worse than
 * not linking: it tells a reader the record is there and then denies it.
 *
 * CREATOR REPUTATION IS DERIVED, AND EVERY INPUT IS LISTED. It used to be a
 * stored column that defaulted to 0 and that nothing ever wrote, printed here as
 * "creator reputation". It is now GET /v1/creators/:id/reputation: the mean
 * performance score of the creator's active agents, each from its latest SEALED
 * score, with each of those scores linked to the page that recomputes it. Where
 * no sealed score exists, the page says "not measured" rather than printing 0.
 *
 * A RETIRED AGENT KEEPS ITS ROW. A creator's record is the whole of what they
 * have run, and hiding the ones that stopped would make every creator look like
 * their surviving agents.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent, qs } from '@/lib/api';
import { addr, int, num, score as fmtScore, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, StatusTag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Creator = {
  id: string;
  handle: string;
  walletAddress: string | null;
  walletVerifiedAt: string | null;
  origin: string | null;
  legacyWalletNote?: string | null;
  status: string;
  provenance: string | null;
  createdAt: string;
};

type CreatorAgent = {
  id: string;
  name: string;
  version: number;
  status: string;
  strategy_type: string | null;
  asset_universe: string | null;
  parent_agent_id: string | null;
  created_at: string;
  decisions: number | null;
  latest_arcana_score: number | null;
};

type AgentsPage = {
  creator_id: string;
  total_agents: number;
  total_pages: number;
  agents: CreatorAgent[];
};

type Reputation = {
  version: string;
  value: number | null;
  status: 'measured' | 'not_measured';
  note: string;
  agents: Array<{
    agent_id: string;
    name: string;
    score_ts: string;
    season_id: string;
    performance_score: number;
    seal: string;
    anchored: boolean;
  }>;
  excluded: Array<{ agent_id: string; name: string; status: string; reason: string }>;
  formula: string[];
  how_to_check: string;
};

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // In the order destructured below.
  const [profileR, agentsR, repR] = await Promise.all([
    agent<Creator>(`/v1/creators/${id}`),
    agent<AgentsPage>(`/v1/creators/${id}/agents?page_size=100`),
    agent<Reputation>(`/v1/creators/${id}/reputation`),
  ]);

  if (!profileR.ok && profileR.status === 404) notFound();
  if (!profileR.ok) {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
          <Failed what="This creator" error={profileR} />
        </div>
        <Footer />
      </div>
    );
  }

  const c = profileR.data;
  const agents = agentsR.ok ? agentsR.data.agents : [];
  const live = agents.filter((a) => a.status === 'active');
  const retired = agents.filter((a) => a.status === 'retired');
  const rep = repR.ok ? repR.data : null;
  const scored = agents.filter((a) => typeof a.latest_arcana_score === 'number');
  const best = scored.reduce<CreatorAgent | null>(
    (b, a) => (b === null || (a.latest_arcana_score as number) > (b.latest_arcana_score as number) ? a : b),
    null,
  );

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 26, paddingBottom: 20, borderBottom: 'none' }}>
        <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
          Creators / {c.handle}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 30, margin: 0 }}>{c.handle}</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {c.walletAddress ? (
                <span className="mono" title={c.walletAddress}>
                  {addr(c.walletAddress)}
                </span>
              ) : (
                <span
                  className="m3"
                  title="This creator has no wallet address on record, so nothing they list can be paid for."
                >
                  no wallet on record
                </span>
              )}
              <span className="m3">·</span>
              <span>since {utcDate(c.createdAt)}</span>
              <span className="m3">·</span>
              <span>
                <span className="mono">{int(agentsR.ok ? agentsR.data.total_agents : null)}</span> agent
                {agentsR.ok && agentsR.data.total_agents === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Lbl>CREATOR REPUTATION</Lbl>
            <div className="mono" style={{ fontSize: 34, lineHeight: 1, marginTop: 2 }}>
              {rep && rep.value !== null ? num(rep.value, 2) : <span className="m3">—</span>}
            </div>
            <div className="m3" style={{ fontSize: 11, maxWidth: 240 }}>
              {!repR.ok
                ? 'the reputation could not be read'
                : rep!.status === 'measured'
                  ? `mean performance of ${rep!.agents.length} active agent(s), from sealed scores`
                  : 'not measured — no active agent has a sealed score yet'}
            </div>
          </div>
        </div>

        {!c.walletAddress ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn">
              <strong>This creator cannot receive a payment.</strong> No wallet address is on record, so any listing of
              theirs is unbuyable — there is no address a buyer could pay and none the platform could verify a payment
              against.
              {c.legacyWalletNote ? (
                <div className="mono m3" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.5 }}>
                  {c.legacyWalletNote}
                </div>
              ) : null}
            </Callout>
          </div>
        ) : null}
      </div>

      <div className="sec" style={{ paddingBottom: 16, borderBottom: 'none' }}>
        {/*
          THE FORECASTING RECORD, reachable. The page existed from the day the
          feature shipped and nothing on this site linked to it, so the only way
          in was to know the URL — which is the same as it not existing for
          everyone but its author.
        */}
        <div style={{ marginBottom: 14 }}>
          <Link href={`/creators/${id}/theses`} style={{ fontSize: 12.5 }}>
            Forecasting record — every thesis this creator published →
          </Link>
        </div>
        <div className="stat-row">
          <div className="box">
            <Key>Agents live</Key>
            <div className="mono" style={{ fontSize: 20, marginTop: 2 }}>
              {int(live.length)} <span className="m3" style={{ fontSize: 12 }}>of {int(agents.length)}</span>
            </div>
          </div>
          <div className="box">
            <Key>Best published score</Key>
            <div className="mono" style={{ fontSize: 20, marginTop: 2 }}>
              {best ? (
                <Link href={`/agents/${best.id}`}>{fmtScore(best.latest_arcana_score)}</Link>
              ) : (
                <span
                  className="m3"
                  title="No agent of this creator has a published score. Withheld scores are not low scores."
                >
                  —
                </span>
              )}
            </div>
          </div>
          <div className="box">
            <Key>Retired</Key>
            <div className="mono" style={{ fontSize: 20, marginTop: 2 }}>
              {int(retired.length)}
            </div>
          </div>
          <div className="box">
            <Key>Profile status</Key>
            <div style={{ fontSize: 17, marginTop: 2 }}>{c.status}</div>
          </div>
        </div>

        {/* THE REPUTATION, ITEMISED. Every score it averages is listed and links
            to the page that recomputes that score from its sealed manifest. */}
        <div className="box" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <Key>How the reputation is computed</Key>
            {rep ? <span className="mono m3" style={{ fontSize: 11 }}>{rep.version}</span> : null}
          </div>
          {!repR.ok ? (
            <div style={{ marginTop: 8 }}>
              <Failed what="This creator's reputation" error={repR} />
            </div>
          ) : (
            <>
              <ol className="m2" style={{ fontSize: 12, lineHeight: 1.6, margin: '8px 0 0 18px', padding: 0 }}>
                {rep!.formula.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className="m2" style={{ fontSize: 12, marginTop: 8 }}>{rep!.note}</div>
              {rep!.agents.length > 0 ? (
                <div className="scroll-x">
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Sealed score (UTC)</th>
                        <th className="r">Performance</th>
                        <th>Seal</th>
                        <th>On chain</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rep!.agents.map((a) => (
                        <tr key={a.agent_id}>
                          <td>
                            <Link href={`/agents/${a.agent_id}`}>{a.name}</Link>
                          </td>
                          <td className="mono m2" style={{ fontSize: 11.5 }}>{utc(a.score_ts)}</td>
                          <td className="r mono">{num(a.performance_score, 2)}</td>
                          <td className="mono m3" style={{ fontSize: 11 }} title={a.seal}>{a.seal.slice(0, 12)}…</td>
                          <td className={a.anchored ? 'up mono' : 'am mono'} style={{ fontSize: 11.5 }}>
                            {a.anchored ? 'anchored' : 'waiting'}
                          </td>
                          <td style={{ fontSize: 11.5 }}>
                            <Link href={`/agents/${a.agent_id}/score${qs({ season_id: a.season_id, ts: a.score_ts })}`}>
                              recompute
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {rep!.excluded.length > 0 ? (
                <div className="m3" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.55 }}>
                  Left out:{' '}
                  {rep!.excluded.map((e, i) => (
                    <span key={e.agent_id}>
                      {i > 0 ? '; ' : ''}
                      <Link href={`/agents/${e.agent_id}`}>{e.name}</Link> ({e.reason})
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>{rep!.how_to_check}</div>
            </>
          )}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        <Key>Agents</Key>
        {!agentsR.ok ? (
          <div style={{ marginTop: 10 }}>
            <Failed what="This creator's agents" error={agentsR} />
          </div>
        ) : agents.length === 0 ? (
          <div style={{ marginTop: 10 }}>
            <Empty title="No agents yet">
              This creator has never created an agent. A counted zero: the service answered and the list is empty.
            </Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Strategy</th>
                  <th>Universe</th>
                  <th className="r">Decisions</th>
                  <th className="r">Latest score</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} style={a.status === 'retired' ? { color: 'var(--ink-3)' } : undefined}>
                    <td>
                      <Link href={`/agents/${a.id}`}>{a.name}</Link>
                      <span className="mono m3" style={{ fontSize: 10 }}>
                        {' '}
                        v{a.version}
                      </span>
                      {a.parent_agent_id ? (
                        <div className="m3" style={{ fontSize: 10.5 }}>
                          evolved from{' '}
                          <Link href={`/agents/${a.parent_agent_id}`}>{a.parent_agent_id.slice(0, 8)}</Link>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusTag status={a.status} />
                    </td>
                    <td className="m2">{a.strategy_type ?? <span className="m3">not stated</span>}</td>
                    <td className="mono m2" style={{ fontSize: 11.5 }}>
                      {a.asset_universe ?? '—'}
                    </td>
                    <td className="r mono">{int(a.decisions)}</td>
                    <td className="r">
                      {/* An agent with no published score gets a dash and the
                          reason, never a zero — the same rule the leaderboard
                          applies, because it is the same fact. */}
                      <Num
                        value={fmtScore(a.latest_arcana_score)}
                        title={
                          a.latest_arcana_score === null
                            ? 'No score is published for this agent. That is withheld, not low.'
                            : undefined
                        }
                      />
                    </td>
                    <td className="mono m3" style={{ fontSize: 11 }}>
                      {utcDate(a.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Footer />
    </div>
  );
}
