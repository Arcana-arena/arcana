import Link from 'next/link';
import { redirect } from 'next/navigation';
import { agent, ARCA_API } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { addr, int, score as fmtScore, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { SignOutButton } from './SignOutButton';

/**
 * The creator dashboard.
 *
 * WHAT IS HERE IS WHAT THE API HAS. The mockup's overview strip shows
 * subscription earnings, a subscriber count, the agents' combined NAV, and a
 * "needs attention" box naming an exhausted gas budget and a wallet low on ETH.
 * None of those are published by any endpoint: earnings and subscriber counts
 * have no creator-scoped route, combined NAV would mean summing per-agent
 * series in the browser — a second definition of a number the backend owns —
 * and no route reports a wallet's gas balance at all. Each is named below as
 * missing rather than approximated.
 *
 * THE SLOT COUNT IS NOT SHOWN AS "n OF 3" EITHER. The cap on active agents per
 * creator is a constant in the agent service and is not in any response. Three
 * is what it happens to be today; printing it here would make this page a
 * second place that decides it, and the day it changes this page would be
 * confidently wrong.
 *
 * `creator_id: null` IS A NORMAL STATE. Signing in does not create a creator
 * profile, so a wallet with none is offered one instead of being shown an empty
 * dashboard that reads like a failure.
 */
export const dynamic = 'force-dynamic';

type Creator = {
  id: string;
  handle: string;
  walletAddress: string | null;
  walletVerifiedAt: string | null;
  origin: string | null;
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
  page: number;
  page_size: number;
  total_agents: number;
  total_pages: number;
  agents: CreatorAgent[];
};

const asNum = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export default async function MePage() {
  const s = await getSession();

  if (s.state === 'signed_out') redirect('/signin?next=%2Fme');

  if (s.state === 'unknown') {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ padding: '48px 32px', borderBottom: 'none' }}>
          <StatusBox title="We could not confirm your session" bad>
            {s.reason}.
            <div style={{ marginTop: 10 }}>
              You are not being told you are signed out, because that is not what happened — the service that knows
              could not be reached. Nothing has been cleared.
            </div>
          </StatusBox>
        </div>
        <Footer />
      </div>
    );
  }

  const { wallet_address, creator_id } = s.session;

  if (!creator_id) {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ paddingTop: 36, paddingBottom: 48, borderBottom: 'none' }}>
          <h1>You are signed in</h1>
          <div className="mono m2" style={{ fontSize: 12.5, marginTop: 6 }} title={wallet_address}>
            {addr(wallet_address)}
          </div>
          <div style={{ marginTop: 20, maxWidth: 640 }}>
            <Callout tone="note">
              <strong>This wallet has no creator profile yet.</strong> That is a normal state, not an error — signing
              in does not create one. A creator profile is what agents belong to, so one is needed before an agent can
              be created. Creating it is not built into this surface yet; it is{' '}
              <span className="mono">POST /v1/creators</span> with a handle.
            </Callout>
          </div>
          <div style={{ marginTop: 24 }}>
            <SignOutButton />
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  const [profileR, agentsR] = await Promise.all([
    agent<Creator>(`/v1/creators/${creator_id}`),
    agent<AgentsPage>(`/v1/creators/${creator_id}/agents?page_size=50`),
  ]);

  const active = agentsR.ok ? agentsR.data.agents.filter((a) => a.status === 'active') : [];

  return (
    <div className="page">
      <Header />

      <div
        className="sec"
        style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}
      >
        <div>
          <h1>Overview</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {profileR.ok ? (
              <>
                <span style={{ color: 'var(--color-text)' }}>{profileR.data.handle}</span>
                <span className="m3">·</span>
                <span>creator since {utcDate(profileR.data.createdAt)}</span>
                <span className="m3">·</span>
                <span>
                  reputation <Num value={fmtScore(asNum(profileR.data.reputationScore))} />
                </span>
              </>
            ) : (
              <span className="m3">the creator profile could not be read</span>
            )}
            <span className="m3">·</span>
            <span className="mono" title={wallet_address}>
              {addr(wallet_address)}
            </span>
          </div>
        </div>
        <SignOutButton />
      </div>

      <div className="sec" style={{ paddingBottom: 8, borderBottom: 'none' }}>
        <div className="stat-grid" style={{ border: '1px solid var(--color-divider)' }}>
          <div className="stat-cell">
            <Key>Agents</Key>
            <div className="stat-value">
              <Num value={agentsR.ok ? int(agentsR.data.total_agents) : '—'} />
            </div>
            <div className="stat-sub">{active.length} active</div>
          </div>
          <div className="stat-cell">
            <Key>Reputation</Key>
            <div className="stat-value">
              <Num value={profileR.ok ? fmtScore(asNum(profileR.data.reputationScore)) : '—'} />
            </div>
            <div className="stat-sub">peer-derived, from the previous run</div>
          </div>
          <div className="stat-cell">
            <Key>Wallet</Key>
            <div className="stat-value" style={{ fontSize: 17 }} title={wallet_address}>
              {addr(wallet_address)}
            </div>
            <div className="stat-sub">
              {profileR.ok && profileR.data.walletVerifiedAt
                ? `verified ${utcDate(profileR.data.walletVerifiedAt)}`
                : 'verification date not reported'}
            </div>
          </div>
          <div className="stat-cell">
            <Key>Profile status</Key>
            <div className="stat-value" style={{ fontSize: 17 }}>
              {profileR.ok ? profileR.data.status : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 24, paddingBottom: 12, borderBottom: 'none' }}>
        <div className="sec-hd" style={{ padding: 0 }}>
          <h2 style={{ fontSize: 18 }}>My agents</h2>
          <span className="m3" style={{ fontSize: 11.5 }}>
            the cap on active agents is enforced by the service and is not published, so it is not counted here
          </span>
        </div>

        {!agentsR.ok ? (
          <Failed what="Your agents" error={agentsR} />
        ) : agentsR.data.agents.length === 0 ? (
          <Empty title="This creator has no agents yet">
            Nothing has been withheld — there are none. Creating an agent is{' '}
            <span className="mono">POST /v1/agents</span>; it is not built into this surface yet.
          </Empty>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 20,
              marginTop: 14,
            }}
          >
            {agentsR.data.agents.map((a) => (
              <article key={a.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20, lineHeight: 1 }}>
                      <Link href={`/agents/${a.id}`}>{a.name}</Link>{' '}
                      <span className="mono m3" style={{ fontWeight: 400, fontSize: 10 }}>
                        v{a.version}
                      </span>
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <StatusTag status={a.status} />
                      <span className="m2" style={{ fontSize: 11.5 }}>
                        {a.strategy_type ?? 'strategy not stated'}
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {a.latest_arcana_score === null ? (
                      <>
                        <div
                          className="mono m3"
                          style={{ fontSize: 13, lineHeight: 1.4 }}
                          title="No score snapshot exists for this agent. Withheld, not zero."
                        >
                          not scored
                        </div>
                        <Lbl>NO SNAPSHOT</Lbl>
                      </>
                    ) : (
                      <>
                        <div className="mono" style={{ fontSize: 24, lineHeight: 1 }}>
                          {fmtScore(a.latest_arcana_score)}
                        </div>
                        <Lbl>LATEST SCORE</Lbl>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <Lbl>DECISIONS</Lbl>
                    <div className="mono" style={{ fontSize: 15 }}>
                      <Num value={int(a.decisions)} />
                    </div>
                  </div>
                  <div>
                    <Lbl>CREATED</Lbl>
                    <div className="mono" style={{ fontSize: 15 }}>
                      {utcDate(a.created_at)}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
                  <Link href={`/me/agents/${a.id}`} className="btn" style={{ fontSize: 12, padding: '4px 10px' }}>
                    Wallet &amp; custody
                  </Link>
                  <Link href={`/agents/${a.id}`} className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
                    Public profile →
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <Subscriptions wallet={wallet_address} />

      <div className="sec" style={{ paddingTop: 20, paddingBottom: 36, borderBottom: 'none', display: 'grid', gap: 12 }}>
        <Callout tone="note">
          <strong>Four figures from the design are not on this page.</strong> Subscription earnings, the subscriber
          count, the agents&rsquo; combined NAV and the &ldquo;needs attention&rdquo; box (exhausted gas budget, wallet
          low on ETH) have no endpoint behind them. Summing NAV across agents in the browser would be a second
          definition of a number the backend owns, and no route reports a wallet&rsquo;s gas balance at all.
        </Callout>
      </div>

      <Footer />
    </div>
  );
}

/**
 * What this wallet subscribes TO.
 *
 * Not what it earns — that is the other direction and has no endpoint. The
 * distinction is stated rather than left for someone to assume from a heading.
 */
async function Subscriptions({ wallet }: { wallet: string }) {
  const r = await authed<Array<{ phase?: string; trading?: boolean }>>(`/v1/subscriptions/${wallet}`, {
    base: ARCA_API,
  });
  const rows = r.ok && Array.isArray(r.data) ? r.data : [];
  const trading = rows.filter((x) => x.trading).length;
  const inGrace = rows.filter((x) => x.phase === 'grace').length;
  return (
    <div className="sec" style={{ paddingTop: 24, paddingBottom: 12, borderBottom: 'none' }}>
      <div className="sec-hd" style={{ padding: 0 }}>
        <h2 style={{ fontSize: 18 }}>Subscriptions you hold</h2>
        <span className="m3" style={{ fontSize: 11.5 }}>
          agents you pay to follow — not what your own agents earn
        </span>
      </div>
      {!r.ok ? (
        <div style={{ marginTop: 12 }}>
          <Failed what="Your subscriptions" error={{ ok: false, status: r.status, reason: r.reason }} />
        </div>
      ) : Array.isArray(r.data) && r.data.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <Empty title="You are not subscribed to any agent">
            A counted zero: the service answered, and the list is empty.
          </Empty>
        </div>
      ) : (
        /*
         * A SUMMARY AND A LINK, not a JSON dump. This block used to print the
         * raw array because the subscription shape had no designed surface;
         * /me/subscriptions is that surface now, so the dump would be a second
         * place for the same facts to be shown differently.
         *
         * The one number worth putting here is the disagreement: how many
         * subscriptions are ACTIVE versus how many are actually being traded
         * for. A buyer reading "3 subscriptions" and assuming three agents are
         * working is the misreading this line exists to prevent.
         */
        <div style={{ marginTop: 12 }}>
          <div className="m2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            <span className="mono">{rows.length}</span> subscription{rows.length === 1 ? '' : 's'} ·{' '}
            <span className="mono">{trading}</span> actually trading for this wallet
            {inGrace > 0 ? (
              <>
                {' '}
                · <span className="am mono">{inGrace}</span> in grace
              </>
            ) : null}
            .
            {trading < rows.length ? (
              <>
                {' '}
                <span className="am">
                  Fewer are trading than exist — usually an underived or unfunded trading wallet, or a pause you set.
                </span>
              </>
            ) : null}
          </div>
          <Link href="/me/subscriptions" className="btn" style={{ marginTop: 12 }}>
            Open my subscriptions
          </Link>
        </div>
      )}
    </div>
  );
}
