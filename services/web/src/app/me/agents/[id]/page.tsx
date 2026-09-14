/**
 * Manage one agent: its mandate, its limits, its wallet, and what is armed.
 *
 * WHAT IT IS DOING COMES FIRST, WHAT CAN BE CHANGED COMES SECOND. The top of the
 * page is the same row the dashboard shows — status, score, what it holds, what
 * it last decided, gas — plus anything that needs its owner, in full. Below it,
 * every control is a section that opens on its own, and each closed section's
 * summary line says what is currently set. Somebody who came to move a stop does
 * not scroll past a listing form and a retirement warning to reach it.
 *
 * NOTHING IS HIDDEN THAT WAS SAID BEFORE. Every warning and consequence lives
 * inside the section it belongs to, and is shown before its button exactly as
 * it was: pausing keeps protective exits running, retiring sells nothing,
 * evolving starts a new record and hands the seat over.
 *
 * THE MANDATE IS SHOWN AS IMMUTABLE RATHER THAN OFFERED AND REFUSED. The
 * service rejects a mandate edit on anything past draft, with a sentence
 * explaining that evolve is how intent changes.
 *
 * KEY CUSTODY IS A HEADLINE. `shared` means the owner holds the key too and can
 * move funds without the platform — including mid-position — which changes what
 * every other number here means.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { agent as publicRead, marketplace } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { addr, int, num, score as fmtScore, txShort, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, StatusTag, Tag } from '@/components/ds/primitives';
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
import { CompetitionPanel, type EntryCompetition } from './CompetitionPanel';
import { VisibilityPanel, type VisibilityDecision } from './VisibilityPanel';
import type { Attention, Dashboard, Triggers, WalletBalances, WalletTransactions } from '../../shapes';
import type { AgentIntelligence } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Agent = {
  id: string;
  name: string;
  version: number;
  status: string;
  strategyType: string | null;
  assetUniverse: string | null;
  /** Null for a private agent on this PUBLIC read — the owner's copy comes from /intelligence. */
  mandate: string | null;
  riskProfile: Record<string, unknown> | null;
  createdAt: string;
  parentAgentId?: string | null;
  visibility?: 'public' | 'private';
  intelligence?: AgentIntelligence;
};

/** GET /v1/agents/:id/intelligence — owner only. */
type OwnerIntelligence = {
  agent_id: string;
  intelligence: AgentIntelligence;
  strategy_type: string | null;
  mandate: string | null;
  mandate_template: string | null;
  mandate_params: Record<string, unknown> | null;
  mandate_source: string | null;
  risk_profile: Record<string, unknown> | null;
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

const ATTENTION_LABEL: Record<Attention['kind'], string> = {
  guard_held_back: 'CROSSED AND NOT TAKEN',
  unguarded_position: 'NOTHING IS WATCHING',
  gas_low: 'GAS RUNNING OUT',
  paused_by_meter: 'PAUSED BY ITS COST METER',
  no_wallet: 'NO TRADING WALLET',
  quiet: 'NOTHING RECORDED RECENTLY',
  unranked: 'NOT ENOUGH RECORD TO RANK',
};
const ATTENTION_TONE: Record<Attention['kind'], 'bad' | 'warn' | 'note'> = {
  guard_held_back: 'bad',
  unguarded_position: 'warn',
  gas_low: 'warn',
  paused_by_meter: 'warn',
  no_wallet: 'warn',
  quiet: 'warn',
  unranked: 'note',
};

/** "0.015 = 1.5%" — the fraction and what it means, together. */
const asPct = (v: unknown) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}%`;
};

function riskSummary(p: Record<string, unknown> | null): string {
  if (!p || Object.keys(p).length === 0) return 'nothing set';
  const stop = p.stop_loss_fraction ?? p.stopLossFraction ?? p.stop_loss_pct ?? p.stopLossPct;
  const take = p.take_profit_fraction ?? p.takeProfitFraction ?? p.take_profit_pct ?? p.takeProfitPct;
  const maxPos = p.max_position_pct ?? p.maxPositionPct;
  const parts = [
    stop !== undefined ? `stop ${stop} = ${asPct(stop)}` : 'no stop',
    take !== undefined ? `target ${take} = ${asPct(take)}` : null,
    maxPos !== undefined ? `max position ${asPct(maxPos)}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

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
  // IN THE ORDER OF THE ARRAY BELOW. Destructuring them anywhere else hands
  // each variable another endpoint's answer, which the type checker caught.
  const [walletR, triggersR, intelR, decisionsR, disclosuresR, listingsR, creatorR] = await Promise.all([
    authed<Wallet>(`/v1/agents/${id}/wallet`),
    authed<Triggers>(`/v1/agents/${id}/triggers`),
    // THE OWNER'S OWN COPY OF WHAT A PRIVATE AGENT WITHHOLDS. The public read
    // above masks a private agent's mandate and risk rules, so this page must
    // not edit or show them from it — it would show nothing and save nothing.
    authed<OwnerIntelligence>(`/v1/agents/${id}/intelligence`),
    // Recent decisions, for opening one at a time. Public: ids, times and seals
    // are part of the record for every agent.
    publicRead<{ decisions: VisibilityDecision[] }>(`/v1/agents/${id}/decisions?page_size=12&include_prices=false`),
    publicRead<{ items: Array<{ scope: string; decision_id: number | null; disclosed_at: string }> }>(
      `/v1/agents/${id}/disclosures`,
    ),
    // PUBLIC, and a lookup by key rather than a search.
    marketplace<Array<{ id: string; agentId: string; priceUsd: string | null; active: boolean }>>(
      '/v1/marketplace/listings',
    ),
    // THE DASHBOARD ROW FOR THIS AGENT — the same numbers, the same attention
    // items, one definition.
    s.state === 'signed_in' && s.session.creator_id
      ? authed<Dashboard>(`/v1/creators/${s.session.creator_id}/dashboard`)
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
  const attention = creatorR.ok ? creatorR.data.attention.filter((x) => x.agent_id === id) : [];
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

  // PUBLIC, and awaited on its own rather than added to the array above.
  const competitionsR = await publicRead<{ items: EntryCompetition[] }>('/v1/competitions?page_size=50');
  const competitions = competitionsR.ok ? competitionsR.data.items.filter((c) => c.status !== 'completed') : [];
  const seats = competitions.filter((c) => (c.participantIds ?? []).includes(id)).length;

  const wallet = walletR.ok ? walletR.data : null;
  const triggers = triggersR.ok ? triggersR.data : null;
  const armedSymbols = (triggers?.armed ?? []).map((g) => g.symbol);
  const visibility = intelR.ok ? intelR.data.intelligence.visibility : a.visibility ?? 'public';
  const riskProfile = intelR.ok ? (intelR.data.risk_profile as Record<string, unknown> | null) : a.riskProfile ?? null;

  return (
    <Shell current="Dashboard" creatorId={s.session.creator_id ?? undefined}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
        <Link href="/me" className="m2">
          Dashboard
        </Link>{' '}
        / {a.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>{a.name}</h1>
        <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
          v{a.version}
        </span>
        <StatusTag status={a.status} />
        {wallet?.key_custody === 'shared' ? <Tag tone="amber">KEY SHARED</Tag> : null}
        <Link href={`/agents/${a.id}`} style={{ fontSize: 12, marginLeft: 'auto' }}>
          Public profile →
        </Link>
      </div>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 6 }}>
        {a.strategyType ?? 'strategy not stated'} · <span className="mono">{a.assetUniverse ?? 'universe not stated'}</span> ·
        created {utcDate(a.createdAt)}
      </div>

      {/* WHAT IT IS DOING NOW — the dashboard row, with room. */}
      {dashAgent ? (
        <div className="stat-row" style={{ marginTop: 16 }}>
          <div className="box">
            <Lbl>{dashAgent.ranked ? 'SCORE' : 'SCORE · NOT PUBLISHED'}</Lbl>
            <div className="mono" style={{ fontSize: 20, marginTop: 4 }}>
              {dashAgent.latest_score === null ? <span className="m3">—</span> : fmtScore(dashAgent.latest_score)}
            </div>
            <div className="m3" style={{ fontSize: 10.5 }}>
              {int(dashAgent.decisions)} decisions{dashAgent.ranked ? '' : ` of ${dashAgent.decisions_needed_to_rank} needed`}
            </div>
          </div>
          <div className="box">
            <Lbl>HOLDING</Lbl>
            <div className="mono" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              {dashAgent.positions === null ? (
                <span className="m3">no snapshot yet</span>
              ) : dashAgent.positions.length === 0 ? (
                <span className="m2">cash only</span>
              ) : (
                dashAgent.positions.map((p) => (
                  <div key={p.symbol}>
                    {p.symbol} <span className="m3">{p.qty}</span>
                  </div>
                ))
              )}
            </div>
            <div className="m3" style={{ fontSize: 10.5 }}>
              {dashAgent.nav === null ? 'no NAV yet' : `NAV ${num(dashAgent.nav, 2)}`}
              {dashAgent.nav_at ? ` · ${utc(dashAgent.nav_at)}` : ''}
            </div>
          </div>
          <div className="box">
            <Lbl>LAST DECISION</Lbl>
            <div className="mono" style={{ fontSize: 13, marginTop: 6 }}>
              {dashAgent.last_decision ? (
                `${dashAgent.last_decision.action}${dashAgent.last_decision.symbol ? ` ${dashAgent.last_decision.symbol}` : ''}`
              ) : (
                <span className="m3">has never decided</span>
              )}
            </div>
            <div className="m3" style={{ fontSize: 10.5 }}>
              {dashAgent.last_decision_at ? utc(dashAgent.last_decision_at) : ''}
              {dashAgent.last_decision?.decider === 'protective' ? ' · protective exit' : ''}
            </div>
          </div>
          <div className="box" style={dashAgent.gas?.low ? { borderColor: 'rgba(212,162,74,.5)' } : undefined}>
            <Lbl>GAS</Lbl>
            <div className={dashAgent.gas?.low ? 'mono am' : 'mono'} style={{ fontSize: 13, marginTop: 6 }}>
              {!dashAgent.gas ? (
                <span className="m3">{dashAgent.wallet ? 'not read for this status' : 'no wallet'}</span>
              ) : dashAgent.gas.known ? (
                `~${int(dashAgent.gas.transactions_affordable)} transactions left`
              ) : (
                <span className="m3">runway unknown</span>
              )}
            </div>
            <div className="m3" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
              {dashAgent.gas?.native_amount ? `${dashAgent.gas.native_amount} ETH · ` : ''}
              <Link href={`/me/agents/${id}?tab=wallet`}>wallet</Link>
            </div>
          </div>
        </div>
      ) : null}

      {attention.length > 0 ? (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {attention.map((x, i) => (
            <Callout key={`${x.kind}-${i}`} tone={ATTENTION_TONE[x.kind]}>
              <strong>{ATTENTION_LABEL[x.kind]}</strong>
              {x.since ? <span className="mono m3" style={{ fontSize: 10.5 }}> · since {utc(x.since)}</span> : null}
              <div style={{ marginTop: 4 }}>{x.detail}</div>
            </Callout>
          ))}
        </div>
      ) : null}

      {a.status === 'paused' ? (
        <div style={{ marginTop: 14 }}>
          <Callout tone="bad">
            <strong>This agent is paused.</strong> It decides nothing until you resume it. Protective levels you
            already have stay armed and are still checked against the price — see Lifecycle below for what a pause
            does and does not stop.
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
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
            {/* A DRAFT'S ONE JOB IS TO BE ACTIVATED, so its lifecycle opens first. */}
            <Fold
              title="Lifecycle"
              state={
                a.status === 'draft'
                  ? 'draft — activate it'
                  : a.status === 'retired'
                    ? 'retired'
                    : a.status === 'paused'
                      ? 'paused — resume · evolve · retire'
                      : 'pause · evolve · retire'
              }
              open={a.status === 'draft'}
            >
              <LifecyclePanel
                agentId={id}
                agentName={a.name}
                status={a.status}
                armedSymbols={armedSymbols}
                visibility={visibility}
              />
            </Fold>

            <Fold title="Risk limits" state={riskSummary(riskProfile)}>
              <RiskEditor
                agentId={id}
                // The owner's copy: a private agent's public read carries no risk
                // profile, and editing from that would overwrite the real one.
                initial={riskProfile}
                editable={a.status !== 'retired'}
              />
            </Fold>

            <Fold
              title="Competitions"
              state={seats === 0 ? 'no seat — nothing asks it to decide' : `seat in ${seats}`}
              open={a.status === 'active' && seats === 0}
            >
              {competitionsR.ok ? (
                <CompetitionPanel agentId={id} agentName={a.name} agentStatus={a.status} competitions={competitions} />
              ) : (
                <Failed what="The competitions this agent can enter" error={competitionsR} />
              )}
            </Fold>

            <Fold title="Mandate" state={a.status === 'draft' ? 'editable while this is a draft' : `immutable for v${a.version}`}>
              <section className="box">
                <span className="k">Mandate</span>
                {intelR.ok && intelR.data.intelligence.private ? (
                  <div className="m3" style={{ fontSize: 11.5, marginTop: 6 }}>
                    Private — only you can read this. It appears on no public surface.
                  </div>
                ) : null}
                {/* READ FROM THE OWNER'S COPY. The public read masks a private
                    agent's mandate, so falling back to it would print "no mandate"
                    about an agent that has one. */}
                {(intelR.ok ? intelR.data.mandate : a.mandate) ? (
                  <pre className="mandate">{intelR.ok ? intelR.data.mandate : a.mandate}</pre>
                ) : !intelR.ok && a.intelligence?.private ? (
                  <Failed what="Your copy of this private mandate" error={intelR} />
                ) : (
                  <div className="m3" style={{ fontSize: 12, marginTop: 8 }}>
                    No mandate is recorded on this agent.
                  </div>
                )}
                {a.status !== 'draft' ? (
                  <div className="m3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}>
                    A mandate cannot be edited once an agent has started. Its recorded performance was produced under
                    this text, so changing it in place would leave the leaderboard describing an agent that no longer
                    exists. Changing intent is what a new version is for (Lifecycle → Evolve) — the boundary is
                    visible to anyone reading the history.
                  </div>
                ) : null}
              </section>
            </Fold>

            <Fold title="Visibility" state={visibility === 'private' ? 'private' : 'public'}>
              <VisibilityPanel
                agentId={id}
                agentName={a.name}
                visibility={visibility}
                disclosedAt={intelR.ok ? intelR.data.intelligence.disclosed_at : null}
                decisions={decisionsR.ok ? decisionsR.data.decisions : []}
                opened={
                  disclosuresR.ok
                    ? disclosuresR.data.items
                        .filter((x) => x.scope === 'decision' && x.decision_id !== null)
                        .map((x) => x.decision_id as number)
                    : []
                }
              />
            </Fold>

            <Fold
              title="Marketplace listing"
              state={
                listing
                  ? `${listing.active ? 'listed' : 'listing off'} · ${int(listing.subscribersActive)} subscriber${listing.subscribersActive === 1 ? '' : 's'}`
                  : 'not listed'
              }
            >
              <ListingPanel agentId={id} listing={listing} agentStatus={a.status} creatorCanBePaid={creatorCanBePaid} />
            </Fold>
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

/** One control, closed until wanted; its summary says what is set now. */
function Fold({ title, state, open, children }: { title: string; state: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="fold" open={open}>
      <summary>
        <span>{title}</span>
        <span className="fold-state">{state}</span>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
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
              the owner's wallet. */}
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
                        {/* A GUARD FIRED IT, NOT THE AGENT. */}
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
          which is why this works whatever the agent&rsquo;s status — including after it is retired.{' '}
          <span className="mono m3">{addr(wallet.address)}</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <ExportKeyPanel agentId={id} agentName={agentName} />
        </div>
      </section>
    </div>
  );
}
