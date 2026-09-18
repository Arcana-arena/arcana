/**
 * The creator dashboard.
 *
 * IT ANSWERS ONE QUESTION: what are my agents doing right now. One row per
 * agent — name, status, score, what it holds, what it last decided, and whether
 * anything needs its owner. No form, no settings, no wallet panel: everything
 * that changes an agent is on that agent's own page, so somebody looking after
 * one agent is not shown the controls for the others.
 *
 * WARNINGS SIT ON THE ROW THEY BELONG TO. They used to be a separate list above
 * the agents, which meant every troubled agent appeared twice and the list and
 * the cards had to be read against each other. Each item still carries its full
 * sentence — the label alone says that something is wrong, the detail says what.
 *
 * "ACTIVE" IS NOT THE SAME AS "WORKING", and the row is built around that gap:
 * an agent can be active with no wallet, active and quiet, active and holding an
 * unguarded position, or active with almost no gas left.
 *
 * MONEY MOVED TO /me/earnings. Subscribers, payments and reputation are about
 * the creator, not about what the agents are doing; they are one click away
 * rather than between an owner and their agents.
 *
 * `creator_id: null` IS A NORMAL STATE. Signing in does not create a creator
 * profile, so a wallet with none is offered the form that makes one rather than
 * shown an empty dashboard that reads like a failure.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { addr, int, score as fmtScore, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { StatusTag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { SignOutButton } from './SignOutButton';
import { CreatorNav } from './CreatorNav';
import { CreateProfileForm } from './CreateProfileForm';
import type { Attention, Dashboard, DashboardAgent } from './shapes';

export const dynamic = 'force-dynamic';

export default async function MePage() {
  const s = await getSession();

  if (s.state === 'signed_out') redirect('/signin?next=%2Fme');

  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}.
          <div style={{ marginTop: 10 }}>
            You are not being told you are signed out, because that is not what happened — the service that knows
            could not be reached. Nothing has been cleared.
          </div>
        </StatusBox>
      </Shell>
    );
  }

  const { wallet_address, creator_id } = s.session;

  if (!creator_id) {
    return (
      <Shell>
        <div style={{ paddingTop: 8 }}>
          <h1>Set up your creator profile</h1>
          <div className="mono m2" style={{ fontSize: 12.5, marginTop: 6 }} title={wallet_address}>
            {addr(wallet_address)}
          </div>
          <div style={{ marginTop: 20, maxWidth: 640 }}>
            <Callout tone="note">
              <strong>This wallet has no creator profile yet.</strong> That is a normal state, not an error — signing
              in does not create one, because choosing the name every agent of yours will be shown under is a
              deliberate act rather than a side effect of arriving. It takes a handle, and then this page becomes
              your dashboard.
            </Callout>
          </div>
          <div style={{ marginTop: 22 }}>
            <CreateProfileForm wallet={wallet_address} />
          </div>
          <div style={{ marginTop: 24 }}>
            <SignOutButton />
          </div>
        </div>
      </Shell>
    );
  }

  const dashR = await authed<Dashboard>(`/v1/creators/${creator_id}/dashboard`);

  if (!dashR.ok) {
    return (
      <Shell>
        <Failed what="Your dashboard" error={{ ok: false, status: dashR.status, reason: dashR.reason, code: dashR.code }} />
      </Shell>
    );
  }

  const d = dashR.data;
  const live = d.agents.filter((a) => a.status !== 'retired');
  const retired = d.agents.filter((a) => a.status === 'retired');
  const attentionFor = (id: string) => d.attention.filter((x) => x.agent_id === id);

  return (
    <Shell creatorId={creator_id} current="Dashboard" handle={d.creator.handle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>What your agents are doing</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-text)' }}>{d.creator.handle}</span>
            <span className="m3">·</span>
            <span className="mono" title={wallet_address}>
              {addr(wallet_address)}
            </span>
            <span className="m3">·</span>
            <span title={d.slots.note}>
              {int(d.slots.active)} of {int(d.slots.cap)} slots used
              {d.slots.free > 0 ? ` · ${d.slots.free} slot${d.slots.free === 1 ? '' : 's'} free` : ''}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {d.slots.free > 0 ? (
            <Link href="/me/agents/new" className="btn btn-primary">
              Create agent
            </Link>
          ) : (
            <span className="btn" style={{ opacity: 0.45, cursor: 'not-allowed' }} title={d.slots.note}>
              Every slot is used
            </span>
          )}
          <SignOutButton />
        </div>
      </div>

      <section style={{ marginTop: 22 }}>
        {d.agents.length === 0 ? (
          <Empty title="No agents yet">
            You have not created an agent. A counted zero: the service answered and the list is empty.{' '}
            <Link href="/me/agents/new">Create your first agent</Link>.
          </Empty>
        ) : live.length === 0 ? (
          <Empty title="No agent is running">
            Every agent of yours is retired, and their records stay readable below.{' '}
            {d.slots.free > 0 ? <Link href="/me/agents/new">Create a new one</Link> : null}
          </Empty>
        ) : (
          <AgentTable agents={live} attentionFor={attentionFor} />
        )}
      </section>

      {retired.length > 0 ? (
        <details className="fold" style={{ marginTop: 18 }}>
          <summary>Retired · {int(retired.length)}</summary>
          <div style={{ marginTop: 10 }}>
            <AgentTable agents={retired} attentionFor={() => []} />
          </div>
        </details>
      ) : null}

      <div className="m3" style={{ fontSize: 10.5, marginTop: 18, lineHeight: 1.45, maxWidth: 760 }}>
        {d.attention_note} What each agent holds and what its closed positions made is on{' '}
        <Link href="/me/portfolio">Portfolio</Link>; payments, subscribers and reputation are on{' '}
        <Link href="/me/earnings">Earnings</Link>.{' '}
        <span className="mono">read {utc(d.as_of)}</span>
      </div>
    </Shell>
  );
}

function Shell({
  children,
  creatorId,
  current,
  handle,
}: {
  children: React.ReactNode;
  creatorId?: string;
  current?: string;
  handle?: string;
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

const ATTENTION_LABEL: Record<Attention['kind'], string> = {
  guard_held_back: 'CROSSED AND NOT TAKEN',
  unguarded_position: 'NOTHING IS WATCHING',
  gas_low: 'GAS RUNNING OUT',
  paused_by_meter: 'PAUSED BY ITS COST METER',
  no_wallet: 'NO TRADING WALLET',
  quiet: 'NOTHING RECORDED RECENTLY',
  unranked: 'NOT ENOUGH RECORD TO RANK',
};

/** The worst kinds are red. An unranked agent is information, not an alarm. */
const ATTENTION_TONE: Record<Attention['kind'], 'dn' | 'am' | 'm3'> = {
  guard_held_back: 'dn',
  unguarded_position: 'am',
  gas_low: 'am',
  paused_by_meter: 'am',
  no_wallet: 'am',
  quiet: 'am',
  unranked: 'm3',
};

const ORDER: Attention['kind'][] = ['guard_held_back', 'unguarded_position', 'gas_low', 'paused_by_meter', 'no_wallet', 'quiet', 'unranked'];

/** "0.000412300000" → "0.0004123"; an exact zero reads as 0, not eighteen zeros. */
const ethShort = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

function ago(ts: string | null): string {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return utc(ts);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function AgentTable({ agents, attentionFor }: { agents: DashboardAgent[]; attentionFor: (id: string) => Attention[] }) {
  return (
    <div className="scroll-x">
      <table className="table agent-rows">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th className="r">Score</th>
            <th>Holding</th>
            <th>Last decision</th>
            <th>Needs you</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <AgentRow key={a.id} a={a} attention={attentionFor(a.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ a, attention }: { a: DashboardAgent; attention: Attention[] }) {
  const items = [...attention].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));
  const live = a.status === 'active' || a.status === 'paused';

  return (
    <tr>
      <td data-label="Agent" style={{ minWidth: 150 }}>
        <Link href={`/me/agents/${a.id}`} style={{ fontWeight: 500 }}>
          {a.name}
        </Link>{' '}
        <span className="mono m3" style={{ fontSize: 10 }}>
          v{a.version}
        </span>
        <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
          {a.wallet?.key_custody === 'shared' ? <span className="am">key shared · </span> : null}
          <Link href={`/me/agents/${a.id}`} className="m3">
            manage →
          </Link>
        </div>
      </td>
      <td data-label="Status">
        <StatusTag status={a.status} />
      </td>
      <td data-label="Score" className="r mono" style={{ whiteSpace: 'nowrap' }}>
        {/* THE ENGINE'S LAST SCORE, AND WHETHER ANYBODY ELSE CAN SEE IT. The
            leaderboard withholds below the threshold; this does not. */}
        {a.latest_score === null ? <span className="m3">—</span> : fmtScore(a.latest_score)}
        <div className="m3" style={{ fontSize: 9.5, fontFamily: 'var(--font-body)' }}>
          {a.ranked ? 'published' : `not published · ${int(a.decisions)}/${int(a.decisions_needed_to_rank)}`}
        </div>
      </td>
      <td data-label="Holding" style={{ minWidth: 120 }}>
        {a.positions === null ? (
          <span className="m3">no snapshot yet</span>
        ) : a.positions.length === 0 ? (
          <span className="m2">cash only</span>
        ) : (
          <span className="mono" title={a.positions.map((p) => `${p.symbol} ${p.qty}`).join(' · ')}>
            {a.positions.slice(0, 4).map((p) => p.symbol).join(', ')}
            {a.positions.length > 4 ? <span className="m3"> +{a.positions.length - 4}</span> : null}
          </span>
        )}
        {a.guards.armed > 0 ? (
          <div className="m3" style={{ fontSize: 10.5 }}>
            {a.guards.armed} stop{a.guards.armed === 1 ? '' : 's'} armed
          </div>
        ) : null}
      </td>
      <td data-label="Last decision" style={{ minWidth: 130 }}>
        {a.last_decision ? (
          <>
            <span className="mono">
              {a.last_decision.action}
              {a.last_decision.symbol ? ` ${a.last_decision.symbol}` : ''}
            </span>
            <div className="m3" style={{ fontSize: 10.5 }} title={a.last_decision_at ? utc(a.last_decision_at) : undefined}>
              {ago(a.last_decision_at)}
              {a.last_decision.decider === 'protective' ? ' · protective exit' : ''}
            </div>
          </>
        ) : (
          <span className="m3">has never decided</span>
        )}
      </td>
      <td data-label="Needs you" style={{ minWidth: 220 }}>
        {items.length === 0 ? (
          live ? (
            <span className="up" style={{ fontSize: 12 }}>
              nothing
            </span>
          ) : (
            <span className="m3">—</span>
          )
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((x, i) => (
              <div key={`${x.kind}-${i}`}>
                <div className={`mono ${ATTENTION_TONE[x.kind]}`} style={{ fontSize: 10.5, letterSpacing: '.04em' }}>
                  {ATTENTION_LABEL[x.kind]}
                  {x.since ? <span className="m3"> · since {utc(x.since)}</span> : null}
                </div>
                {x.kind !== 'unranked' ? (
                  <div className="m2" style={{ fontSize: 11, lineHeight: 1.4 }}>
                    {x.detail}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {/* UNKNOWN GAS IS SAID, NOT LEFT BLANK. A blank would read as enough. */}
        {live && a.gas && !a.gas.known ? (
          <div className="m3" style={{ fontSize: 10.5, marginTop: items.length ? 6 : 2, lineHeight: 1.4 }} title={a.gas.note ?? undefined}>
            gas runway unknown{a.gas.native_amount ? ` · ${ethShort(a.gas.native_amount)} ETH` : ''}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
