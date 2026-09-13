/**
 * A creator, and the agents they are responsible for.
 *
 * WHY THIS PAGE EXISTS NOW. The marketplace grid and every listing page name a
 * creator and link to them. Linking somewhere that answers 404 is worse than
 * not linking: it tells a reader the record is there and then denies it.
 *
 * CREATOR REPUTATION IS SHOWN AS ITS OWN STORED FIGURE, and where that figure
 * is 0.00 the page says whether it has ever been computed rather than printing
 * a zero that reads as a judgement. The design's four reputation components —
 * median score, agents survived, mandate honesty, subscriber P&L — are not
 * published by any endpoint and are not invented here; the one number that does
 * exist is shown, with what feeds it named.
 *
 * A RETIRED AGENT KEEPS ITS ROW. A creator's record is the whole of what they
 * have run, and hiding the ones that stopped would make every creator look like
 * their surviving agents.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent } from '@/lib/api';
import { addr, int, num, score as fmtScore, utcDate } from '@/lib/format';
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
  reputationScore: string | number | null;
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

const asNum = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [profileR, agentsR] = await Promise.all([
    agent<Creator>(`/v1/creators/${id}`),
    agent<AgentsPage>(`/v1/creators/${id}/agents?page_size=100`),
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
  const rep = asNum(c.reputationScore);
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
            {/*
              A STORED ZERO IS STILL A ZERO, and this page must not turn it into
              a dash — but it must also not let it read as a verdict when no
              reputation run has ever written to it. Both facts are printed.
            */}
            <div className="mono" style={{ fontSize: 34, lineHeight: 1, marginTop: 2 }}>
              {rep === null ? <span className="m3">—</span> : num(rep, 2)}
            </div>
            <div className="m3" style={{ fontSize: 11, maxWidth: 220 }}>
              {rep === null
                ? 'no reputation figure is stored for this creator'
                : rep === 0
                  ? 'a stored zero — the reputation run has not yet produced a figure for this creator'
                  : 'feeds one weighted term of each of their agents’ scores'}
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

        {/* THE FOUR COMPONENTS THE DESIGN ASKS FOR DO NOT EXIST. Named as
            absent rather than approximated from whatever is to hand — median
            score, survival rate, mandate honesty and subscriber P&L are four
            different measurements and none of them is published. */}
        <div style={{ marginTop: 16 }}>
          <Callout tone="note">
            <strong>Reputation is one stored number here, not a breakdown.</strong> No endpoint publishes its
            components — median score across their agents, how many survived, how closely their mandates match observed
            behaviour, or what subscribers actually made. Those are four separate measurements and none of them is
            computed, so none of them is shown.
          </Callout>
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
