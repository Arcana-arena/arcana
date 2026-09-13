/**
 * Manage one agent: its mandate, its limits, its wallet, and what is armed.
 *
 * THE MANDATE IS SHOWN AS IMMUTABLE RATHER THAN OFFERED AND REFUSED. The
 * service rejects a mandate edit on anything past draft, with a sentence
 * explaining that evolve is how intent changes. Letting somebody write a new
 * mandate and then showing them that refusal teaches the same fact at the
 * worst possible moment, so the field is not there and the reason is.
 *
 * THE THREE PLACES THIS PLATFORM DIFFERS FROM ITS OWN DESIGN are all on this
 * page, and the platform's behaviour is what is printed: pausing stops
 * protective exits, retiring sells nothing, and evolving hands the seat over
 * rather than losing it. Every one of those was read out of the code rather
 * than assumed.
 *
 * KEY CUSTODY IS A HEADLINE. `shared` means the owner holds the key too and can
 * move funds without the platform — including mid-position — which changes what
 * every other number here means.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { agent as publicRead, marketplace } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { addr, int, num, txShort, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { Tabs } from '@/components/ds/nav';
import { CreatorNav } from '../../CreatorNav';
import {
  DeriveWalletButton,
  ExportKeyPanel,
  LifecyclePanel,
  RiskEditor,
  TriggersPanel,
} from './ManagePanels';
import { ListingPanel } from './ListingPanel';
import type { Triggers, WalletBalances, WalletTransactions } from '../../shapes';

export const dynamic = 'force-dynamic';

type Agent = {
  id: string;
  name: string;
  version: number;
  status: string;
  strategyType: string | null;
  assetUniverse: string | null;
  mandate: string | null;
  riskProfile: Record<string, unknown> | null;
  createdAt: string;
  parentAgentId?: string | null;
};

type Wallet = {
  agent_id: string;
  address: string;
  key_custody: string | null;
  exported_at: string | null;
  imported_at: string | null;
  note: string | null;
};

const TABS = [
  { key: 'manage', label: 'Manage' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'triggers', label: 'Triggers' },
];

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ManageAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === one(sp.tab)) ? (one(sp.tab) as string) : 'manage';

  const s = await getSession();
  if (s.state === 'signed_out') redirect(`/signin?next=%2Fme%2Fagents%2F${encodeURIComponent(id)}`);
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared — you are not being told you are signed out when the truth is that a
          service could not be reached.
        </StatusBox>
      </Shell>
    );
  }

  const agentR = await publicRead<Agent>(`/v1/agents/${id}`);
  if (!agentR.ok && agentR.status === 404) notFound();
  if (!agentR.ok) {
    return (
      <Shell>
        <Failed what="This agent" error={agentR} />
      </Shell>
    );
  }
  const a = agentR.data;

  // Owner-only reads. A refusal is printed as a refusal: an agent that is not
  // yours must not render as an agent with nothing in it.
  const [walletR, triggersR, listingsR, creatorR] = await Promise.all([
    authed<Wallet>(`/v1/agents/${id}/wallet`),
    authed<Triggers>(`/v1/agents/${id}/triggers`),
    // PUBLIC, and a lookup by key rather than a search. The listing table is
    // small and the page needs the one row whose agentId is this agent; asking
    // the browse endpoint would apply a provenance filter that has nothing to
    // do with whether the owner may see their own listing.
    marketplace<Array<{ id: string; agentId: string; priceUsd: string | null; active: boolean }>>(
      '/v1/marketplace/listings',
    ),
    s.state === 'signed_in' && s.session.creator_id
      ? authed<{ creator: { can_be_paid: boolean }; agents: Array<{ id: string; listing: { subscribers_active: number } | null }> }>(
          `/v1/creators/${s.session.creator_id}/dashboard`,
        )
      : Promise.resolve({ ok: false as const, status: null, reason: 'no creator profile', body: null }),
  ]);

  if (!walletR.ok && (walletR.status === 403 || walletR.status === 404)) {
    return (
      <Shell>
        <StatusBox title="This agent is not yours" bad>
          {walletR.reason}
          <div style={{ marginTop: 10 }}>
            Its public record is readable by anyone: <Link href={`/agents/${id}`}>open the profile</Link>.
          </div>
        </StatusBox>
      </Shell>
    );
  }

  const rawListing = listingsR.ok ? listingsR.data.find((l) => l.agentId === id) ?? null : null;
  const dashAgent = creatorR.ok ? creatorR.data.agents.find((x) => x.id === id) ?? null : null;
  const listing = rawListing
    ? {
        id: rawListing.id,
        priceUsd: rawListing.priceUsd === null ? null : Number(rawListing.priceUsd),
        active: rawListing.active === true,
        // The subscriber count comes from the dashboard, which counts it in
        // SQL. Counting it here would be a second definition of "subscriber".
        subscribersActive: dashAgent?.listing?.subscribers_active ?? 0,
      }
    : null;
  const creatorCanBePaid = creatorR.ok ? creatorR.data.creator.can_be_paid : null;

  const wallet = walletR.ok ? walletR.data : null;
  const triggers = triggersR.ok ? triggersR.data : null;
  const armedSymbols = (triggers?.armed ?? []).map((g) => g.symbol);

  return (
    <Shell current="Overview" handle={undefined} creatorId={s.session.creator_id ?? undefined}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
        <Link href="/me" className="m2">
          Overview
        </Link>{' '}
        / {a.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>{a.name}</h1>
        <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
          v{a.version}
        </span>
        <StatusTag status={a.status} />
        <Link href={`/agents/${a.id}`} style={{ fontSize: 12, marginLeft: 'auto' }}>
          Public profile →
        </Link>
      </div>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 6 }}>
        {a.strategyType ?? 'strategy not stated'} · <span className="mono">{a.assetUniverse ?? 'universe not stated'}</span> ·
        created {utcDate(a.createdAt)}
      </div>

      {a.status === 'paused' ? (
        <div style={{ marginTop: 14 }}>
          <Callout tone="bad">
            <strong>This agent is paused, and its protective levels are not being watched.</strong> The guard watcher
            only reads levels belonging to an active agent. Any armed stop on an open position is not being checked
            against the price while this lasts — the rows still say ARMED and nothing disarmed them.
          </Callout>
        </div>
      ) : null}
      {a.status === 'retired' ? (
        <div style={{ marginTop: 14 }}>
          <Callout tone="note">
            <strong>This agent is retired. Its record is frozen.</strong> It decides nothing, holds no seat, and is
            not watched. Whatever it held is still in its wallet and the key is still exportable.
          </Callout>
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: `/me/agents/${id}?tab=${t.key}` }))} />
      </div>

      <div style={{ marginTop: 20 }}>
        {tab === 'manage' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20 }}>
            <section className="box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="k">Mandate</span>
                <span className="m3" style={{ fontSize: 11 }}>
                  {a.status === 'draft' ? 'editable while this is a draft' : `immutable for v${a.version}`}
                </span>
              </div>
              {a.mandate ? (
                <pre className="mandate">{a.mandate}</pre>
              ) : (
                <div className="m3" style={{ fontSize: 12, marginTop: 8 }}>
                  No mandate is recorded on this agent.
                </div>
              )}
              {a.status !== 'draft' ? (
                <div className="m3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}>
                  A mandate cannot be edited once an agent has started. Its recorded performance was produced under
                  this text, so changing it in place would leave the leaderboard describing an agent that no longer
                  exists. Changing intent is what a new version is for — the boundary is visible to anyone reading
                  the history.
                </div>
              ) : null}
            </section>

            <RiskEditor agentId={id} initial={a.riskProfile ?? null} editable={a.status !== 'retired'} />

            <ListingPanel
              agentId={id}
              listing={listing}
              agentStatus={a.status}
              creatorCanBePaid={creatorCanBePaid}
            />

            <LifecyclePanel agentId={id} agentName={a.name} status={a.status} armedSymbols={armedSymbols} />
          </div>
        ) : null}

        {tab === 'wallet' ? <WalletTab id={id} agentName={a.name} wallet={wallet} walletError={walletR.ok ? null : walletR} /> : null}

        {tab === 'triggers' ? (
          !triggersR.ok ? (
            <Failed what="The armed conditions" error={{ ok: false, status: triggersR.status, reason: triggersR.reason }} />
          ) : (
            <TriggersPanel t={triggersR.data} />
          )
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  current,
  handle,
  creatorId,
}: {
  children: React.ReactNode;
  current?: string;
  handle?: string;
  creatorId?: string;
}) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current={current} handle={handle} creatorId={creatorId} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}

async function WalletTab({
  id,
  agentName,
  wallet,
  walletError,
}: {
  id: string;
  agentName: string;
  wallet: { address: string; key_custody: string | null; exported_at: string | null; imported_at: string | null; note: string | null } | null;
  walletError: { status: number | null; reason: string } | null;
}) {
  if (walletError) {
    return <Failed what="This agent's wallet" error={{ ok: false, status: walletError.status, reason: walletError.reason }} />;
  }
  if (!wallet?.address) {
    return (
      <Empty title="This agent has no trading wallet yet">
        Nothing it decides can settle until one exists. The address is a pure function of the agent id under the
        signer&rsquo;s derivation, so deriving it twice gives the same address — there is nothing to get wrong.
        <div style={{ marginTop: 12 }}>
          <DeriveWalletButton agentId={id} />
        </div>
      </Empty>
    );
  }

  const [balR, txR] = await Promise.all([
    authed<WalletBalances>(`/v1/agents/${id}/wallet/balances`),
    authed<WalletTransactions>(`/v1/agents/${id}/wallet/transactions?limit=30`),
  ]);
  const b = balR.ok ? balR.data : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20 }}>
      <section className="box">
        <span className="k">Address</span>
        <div className="mono brk" style={{ fontSize: 12.5, marginTop: 6 }}>
          {wallet.address}
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {wallet.key_custody === 'shared' ? (
            <Tag tone="amber">KEY SHARED</Tag>
          ) : (
            <Tag tone="outline">ARCANA HOLDS THE ONLY KEY</Tag>
          )}
          {wallet.imported_at ? (
            <span className="m3" style={{ fontSize: 11 }}>
              imported {utcDate(wallet.imported_at)}
            </span>
          ) : null}
          {wallet.exported_at ? (
            <span className="m3" style={{ fontSize: 11 }}>
              exported {utcDate(wallet.exported_at)}
            </span>
          ) : null}
        </div>
        {wallet.note ? (
          <div className="m2" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
            {wallet.note}
          </div>
        ) : null}
      </section>

      {!balR.ok ? (
        <Failed what="The balances" error={{ ok: false, status: balR.status, reason: balR.reason }} />
      ) : (
        <>
          <div className="two-col">
            <div className="box">
              <Key>Settlement token</Key>
              <div className="mono" style={{ fontSize: 24, marginTop: 4 }}>
                {b?.token?.available ? b.token.amount : <span className="m3">—</span>}
              </div>
              <div className="m3" style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.45 }}>
                {b?.token?.available ? 'read from the chain just now' : (b?.token?.reason ?? 'not read')}
              </div>
            </div>
            <div
              className="box"
              style={b?.gas?.low ? { borderColor: 'rgba(212,162,74,.5)' } : undefined}
            >
              <Key>Gas</Key>
              <div className={b?.gas?.low ? 'mono am' : 'mono'} style={{ fontSize: 24, marginTop: 4 }}>
                {b?.native?.available ? b.native.amount : <span className="m3">—</span>}
              </div>
              <div className={b?.gas?.low ? 'am' : 'm3'} style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.45 }}>
                {b?.native?.available
                  ? b?.gas?.known
                    ? b.gas.note
                    : b?.gas?.reason
                  : (b?.native?.reason ?? 'not read')}
              </div>
            </div>
          </div>

          {b?.gas?.low ? (
            <Callout tone="warn">
              <strong>This wallet is running out of gas.</strong> At zero, it cannot sell and it cannot fire a
              protective stop either — a stop is a transaction like any other. The figure above is measured from this
              agent&rsquo;s own recent fills, not from a platform-wide guess.
            </Callout>
          ) : null}

          {/* DEPOSIT AND WITHDRAW ARE NOT BUTTONS, because nothing here can
              move money. The platform signs from this wallet; it does not have
              the owner's wallet, and a button that opened a wallet extension
              would be a payment flow this page does not have. */}
          <Callout tone="note">
            <strong>To deposit, send to the address above from your own wallet.</strong> ARCANA has no control over
            your wallet and cannot initiate a transfer from it, so there is no deposit button here — only the address
            to send to. To withdraw, export the key below and move the funds yourself, or retire the agent and do the
            same afterwards. Whatever is in this wallet is yours in both cases.
          </Callout>
        </>
      )}

      <section className="box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="k">Transactions</span>
          {txR.ok ? (
            <span className="mono m3" style={{ fontSize: 10.5 }}>
              {int(txR.data.totals.executions)} recorded · {int(txR.data.totals.failed)} failed ·{' '}
              {int(txR.data.totals.unpriced)} unpriced
            </span>
          ) : null}
        </div>
        {!txR.ok ? (
          <div style={{ marginTop: 10 }}>
            <Failed what="The transactions" error={{ ok: false, status: txR.status, reason: txR.reason }} />
          </div>
        ) : txR.data.items.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            ARCANA has made no transaction from this wallet. A counted zero — and it does not mean the address has no
            history: {txR.data.completeness}
          </div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="table" style={{ marginTop: 10, fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th className="r">Gas</th>
                    <th>Status</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {txR.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>
                        {t.ts ? utc(t.ts).slice(0, 16) : '—'}
                      </td>
                      <td>
                        <span className="mono">{(t.action ?? '—').toUpperCase()}</span>{' '}
                        <span className="mono m2">{t.symbol}</span>
                        {/* A GUARD FIRED IT, NOT THE AGENT. The distinction is
                            the whole point of the protective path. */}
                        {t.fired_by_guard ? (
                          <span className="am" style={{ fontSize: 10 }}>
                            {' '}
                            · protective exit
                          </span>
                        ) : null}
                      </td>
                      <td className="r mono">
                        {t.gas_cost_usd !== null ? (
                          num(t.gas_cost_usd, 4)
                        ) : (
                          <span className="am" title={t.gas_note ?? undefined}>
                            unpriced
                          </span>
                        )}
                      </td>
                      <td className={t.status === 'mined' ? 'up' : t.status === 'failed' ? 'dn' : 'am'} style={{ fontSize: 11 }}>
                        {t.status ?? '—'}
                        {t.refusal_code ? <div className="m3" style={{ fontSize: 10 }}>{t.refusal_code}</div> : null}
                      </td>
                      <td className="mono m2">
                        {t.tx_hash ? <span title={t.tx_hash}>{txShort(t.tx_hash)}</span> : <span className="m3">not sent</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
              {txR.data.completeness}
            </div>
          </>
        )}
      </section>

      <section className="box" style={{ borderColor: 'rgba(210,96,91,.4)' }}>
        <span className="k">Take possession of the key</span>
        <div className="m2" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          This wallet is yours. ARCANA holding the only key to it is a custody arrangement you must be able to end,
          which is why this works whatever the agent&rsquo;s status — including after it is retired.
        </div>
        <div style={{ marginTop: 12 }}>
          <ExportKeyPanel agentId={id} agentName={agentName} />
        </div>
      </section>
    </div>
  );
}
