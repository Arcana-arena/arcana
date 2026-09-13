/**
 * The creator dashboard.
 *
 * THE FIRST THING ON IT IS WHAT IS WRONG. An owner does not open this page to
 * admire a score; they open it to find out whether their money is doing what
 * they told it to. Every item in the attention list names the row it came from
 * and is drawn before the agent cards, because a warning below the fold is a
 * warning nobody read.
 *
 * "ACTIVE" IS NOT THE SAME AS "WORKING", and the cards are built around that
 * gap. An agent can be active with no wallet, active and quiet for a day,
 * active and holding an unguarded position, or active and paused by its own
 * cost meter. Each of those looks identical in a status column.
 *
 * THE SLOT COUNT COMES FROM THE SERVICE. This page used to carry a comment
 * explaining that it could not print "n of 3" because the cap lived in a
 * constant no response contained. It contains it now, with what it counts.
 *
 * `creator_id: null` IS A NORMAL STATE. Signing in does not create a creator
 * profile, so a wallet with none is offered one rather than shown an empty
 * dashboard that reads like a failure.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { addr, int, num, score as fmtScore, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { SignOutButton } from './SignOutButton';
import { CreatorNav } from './CreatorNav';
import type { Attention, Dashboard, DashboardAgent, Earnings } from './shapes';

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
          <h1>You are signed in</h1>
          <div className="mono m2" style={{ fontSize: 12.5, marginTop: 6 }} title={wallet_address}>
            {addr(wallet_address)}
          </div>
          <div style={{ marginTop: 20, maxWidth: 640 }}>
            <Callout tone="note">
              <strong>This wallet has no creator profile yet.</strong> That is a normal state, not an error — signing
              in does not create one. A creator profile is what agents belong to, so one is needed before an agent can
              be created. Creating it is <span className="mono">POST /v1/creators</span> with a handle; it is not wired
              into this surface yet.
            </Callout>
          </div>
          <div style={{ marginTop: 24 }}>
            <SignOutButton />
          </div>
        </div>
      </Shell>
    );
  }

  const [dashR, earnR] = await Promise.all([
    authed<Dashboard>(`/v1/creators/${creator_id}/dashboard`),
    authed<Earnings>(`/v1/creators/${creator_id}/earnings`),
  ]);

  if (!dashR.ok) {
    return (
      <Shell wallet={wallet_address}>
        <Failed what="Your dashboard" error={{ ok: false, status: dashR.status, reason: dashR.reason }} />
      </Shell>
    );
  }

  const d = dashR.data;
  const earnings = earnR.ok ? earnR.data : null;

  return (
    <Shell wallet={wallet_address} creatorId={creator_id} current="Overview" handle={d.creator.handle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1>Overview</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-text)' }}>{d.creator.handle}</span>
            <span className="m3">·</span>
            <span>creator since {utcDate(d.creator.created_at)}</span>
            <span className="m3">·</span>
            <span className="mono" title={wallet_address}>
              {addr(wallet_address)}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {d.slots.free > 0 ? (
            <Link href="/me/agents/new" className="btn btn-primary">
              Create agent · {d.slots.free} slot{d.slots.free === 1 ? '' : 's'} free
            </Link>
          ) : (
            <span
              className="btn"
              style={{ opacity: 0.45, cursor: 'not-allowed' }}
              title={d.slots.note}
            >
              Create agent · {d.slots.active} of {d.slots.cap} slots used
            </span>
          )}
          <SignOutButton />
        </div>
      </div>

      {/* THE WARNINGS COME FIRST. */}
      {d.attention.length > 0 ? (
        <section style={{ marginTop: 22 }}>
          <Key>Needs attention · {int(d.attention.length)}</Key>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {d.attention.map((a, i) => (
              <AttentionRow key={`${a.agent_id}-${a.kind}-${i}`} a={a} />
            ))}
          </div>
          <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45, maxWidth: 760 }}>
            {d.attention_note}
          </div>
        </section>
      ) : d.agents.some((a) => a.status === 'active') ? (
        <div style={{ marginTop: 22 }}>
          <Callout tone="note">
            <strong>Nothing needs attention.</strong> Every active agent has a wallet, has decided recently, and has
            no protective level that was refused or crossed without exiting. This is a checked result, not an empty
            list — the checks are named in the endpoint behind this page.
          </Callout>
        </div>
      ) : null}

      <section style={{ marginTop: 26 }}>
        <div className="stat-row">
          <div className="box">
            <Key>Slots</Key>
            <div className="mono" style={{ fontSize: 22, marginTop: 4 }}>
              {int(d.slots.active)} <span className="m3" style={{ fontSize: 12 }}>of {int(d.slots.cap)}</span>
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
              {d.slots.counts}
            </div>
          </div>
          <div className="box">
            <Key>Subscribers</Key>
            <div className="mono" style={{ fontSize: 22, marginTop: 4 }}>
              {earnings?.subscribers ? int(earnings.subscribers.active) : <span className="m3">—</span>}
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
              {earnings?.subscribers
                ? `${int(earnings.subscribers.grace)} in grace · ${int(earnings.subscribers.distinct_wallets)} distinct wallets`
                : 'not read'}
            </div>
          </div>
          <div className="box">
            <Key>Paid, all time</Key>
            <div className="mono" style={{ fontSize: 22, marginTop: 4 }}>
              {earnings?.totals?.amount ?? <span className="m3">—</span>}
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
              {earnings?.totals
                ? `${int(earnings.totals.payments)} verified payment${earnings.totals.payments === 1 ? '' : 's'}`
                : earnings?.payable === false
                  ? 'no payee address'
                  : 'not read'}
            </div>
          </div>
          <div className="box">
            <Key>Reputation</Key>
            <div className="mono" style={{ fontSize: 22, marginTop: 4 }}>
              {d.creator.reputation_score === null ? (
                <span className="m3">—</span>
              ) : (
                num(d.creator.reputation_score, 2)
              )}
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
              {d.creator.reputation_score === 0
                ? 'a stored zero — no reputation run has written to it'
                : 'feeds one weighted term of each agent’s score'}
            </div>
          </div>
        </div>

        {!d.creator.can_be_paid ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn">
              <strong>This creator has no wallet address, so nothing of yours can be bought.</strong> A listing
              without a payee refuses every quote and every claim — correctly, and after a buyer has already gone
              looking. Nothing on this platform can set it for you: it is the address money will go to.
            </Callout>
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <Key>
            My agents · {int(d.slots.active)} active of {int(d.agents.length)}
          </Key>
          <span className="m3" style={{ fontSize: 11 }}>
            {d.slots.free === 0 ? 'Retire one to free a slot' : `${d.slots.free} slot${d.slots.free === 1 ? '' : 's'} free`}
          </span>
        </div>
        {d.agents.length === 0 ? (
          <div style={{ marginTop: 10 }}>
            <Empty title="No agents yet">
              You have not created an agent. A counted zero: the service answered and the list is empty.{' '}
              <Link href="/me/agents/new">Create your first agent</Link>.
            </Empty>
          </div>
        ) : (
          <div className="sub-grid" style={{ marginTop: 12 }}>
            {d.agents.map((a) => (
              <AgentCard key={a.id} a={a} />
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <EarningsPanel e={earnings} error={earnR.ok ? null : { status: earnR.status, reason: earnR.reason }} />
      </section>

      <div className="mono m3" style={{ fontSize: 10.5, marginTop: 24 }}>
        read {utc(d.as_of)}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  wallet,
  creatorId,
  current,
  handle,
}: {
  children: React.ReactNode;
  wallet?: string;
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
  paused_by_meter: 'PAUSED BY ITS COST METER',
  unguarded_position: 'NOTHING IS WATCHING',
  guard_held_back: 'CROSSED AND NOT TAKEN',
  no_wallet: 'NO TRADING WALLET',
  unranked: 'NOT ENOUGH RECORD TO RANK',
  quiet: 'NOTHING RECORDED RECENTLY',
};

/** The worst kinds are red. An unranked agent is information, not an alarm. */
const ATTENTION_TONE: Record<Attention['kind'], 'bad' | 'warn' | 'note'> = {
  guard_held_back: 'bad',
  unguarded_position: 'warn',
  paused_by_meter: 'warn',
  no_wallet: 'warn',
  quiet: 'warn',
  unranked: 'note',
};

function AttentionRow({ a }: { a: Attention }) {
  return (
    <Callout tone={ATTENTION_TONE[a.kind]}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <strong>
          <Link href={`/me/agents/${a.agent_id}`}>{a.agent_name ?? a.agent_id.slice(0, 8)}</Link> ·{' '}
          {ATTENTION_LABEL[a.kind]}
        </strong>
        {a.since ? (
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            since {utc(a.since)}
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 4 }}>{a.detail}</div>
    </Callout>
  );
}

function AgentCard({ a }: { a: DashboardAgent }) {
  const tone =
    a.guards.held_back > 0
      ? 'rgba(210,96,91,.5)'
      : a.status === 'paused' || a.guards.refused > 0
        ? 'rgba(212,162,74,.5)'
        : undefined;

  return (
    <article className="card" style={tone ? { borderColor: tone } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, lineHeight: 1 }}>
            <Link href={`/me/agents/${a.id}`}>{a.name}</Link>{' '}
            <span className="mono m3" style={{ fontWeight: 400, fontSize: 10 }}>
              v{a.version}
            </span>
          </div>
          <div style={{ fontSize: 11.5, marginTop: 5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusTag status={a.status} />
            {a.listing ? (
              <span className="m2">{a.listing.active ? 'listed' : 'listing off'}</span>
            ) : (
              <span className="m3">not listed</span>
            )}
            {a.guards.held_back > 0 ? <Tag tone="red">STOP HELD BACK</Tag> : null}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          {/* THE ENGINE'S LAST SCORE, AND WHETHER ANYBODY ELSE CAN SEE IT. The
              leaderboard withholds below the threshold; this does not. Showing
              the number to its owner without saying it is unpublished would let
              them quote a rank nobody else can read. */}
          <div className="mono" style={{ fontSize: 22, lineHeight: 1 }}>
            {a.latest_score === null ? <span className="m3">—</span> : fmtScore(a.latest_score)}
          </div>
          <Lbl>{a.ranked ? 'SCORE' : 'NOT PUBLISHED'}</Lbl>
        </div>
      </div>

      {!a.ranked && a.status === 'active' ? (
        <div className="m3" style={{ fontSize: 11, lineHeight: 1.45 }}>
          {int(a.decisions)} of {int(a.decisions_needed_to_rank)} decisions needed before any score is published.
          {a.latest_score !== null
            ? ' The number above is the engine’s last snapshot and is not on the leaderboard.'
            : ''}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div>
          <Lbl>NAV</Lbl>
          <Num value={a.nav === null ? '—' : num(a.nav, 2)} title={a.nav_at ? `snapshot ${utc(a.nav_at)}` : undefined} />
        </div>
        <div>
          <Lbl>DECISIONS</Lbl>
          <Num value={int(a.decisions)} />
        </div>
        <div>
          <Lbl>SUBS</Lbl>
          <Num
            value={a.listing ? int(a.listing.subscribers_active) : '—'}
            title={a.listing ? undefined : 'This agent is not listed, so nobody can subscribe to it.'}
          />
        </div>
      </div>

      <div className="m3" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
        {a.wallet ? (
          <>
            wallet <span className="mono">{addr(a.wallet.address)}</span>
            {a.wallet.key_custody === 'shared' ? (
              <span className="am"> · key shared — you can move funds without the platform</span>
            ) : null}
          </>
        ) : (
          <span className="am">no trading wallet — nothing it decides can settle</span>
        )}
        {a.last_decision_at ? <> · last decision {utc(a.last_decision_at)}</> : ' · has never decided'}
      </div>

      <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
        <Link href={`/me/agents/${a.id}`} className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 12, padding: '4px 8px' }}>
          Manage
        </Link>
        <Link href={`/me/agents/${a.id}?tab=wallet`} className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 12, padding: '4px 8px' }}>
          Wallet
        </Link>
        <Link href={`/agents/${a.id}`} className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 6px' }}>
          Profile →
        </Link>
      </div>
    </article>
  );
}

/**
 * What has actually been paid.
 *
 * A WEEK WITH NO PAYMENT IS ABSENT, not a zero bar. The service returns only
 * the weeks that happened, and drawing the gaps would claim the platform was
 * running and earning nothing in a week before this creator existed.
 */
function EarningsPanel({ e, error }: { e: Earnings | null; error: { status: number | null; reason: string } | null }) {
  if (error) {
    return (
      <>
        <Key>Earnings</Key>
        <div style={{ marginTop: 8 }}>
          <Failed what="Your earnings" error={{ ok: false, status: error.status, reason: error.reason }} />
        </div>
      </>
    );
  }
  if (!e) return null;
  if (e.available === false) {
    return (
      <>
        <Key>Earnings</Key>
        <div style={{ marginTop: 8 }}>
          <Callout tone="warn">
            <strong>The payment record could not be read.</strong> {e.reason}. Nothing is shown rather than an empty
            table, which would mean you have been paid nothing.
          </Callout>
        </div>
      </>
    );
  }
  if (e.payable === false) {
    return (
      <>
        <Key>Earnings</Key>
        <div style={{ marginTop: 8 }}>
          <Callout tone="warn">
            <strong>Nothing could have arrived.</strong> {e.payable_note}
          </Callout>
        </div>
      </>
    );
  }

  const max = e.by_week.reduce((m, w) => Math.max(m, Number(w.base_units)), 0);

  return (
    <div className="two-col">
      <div className="box">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <Key>Payments received · 12 weeks</Key>
          <span className="mono m2" style={{ fontSize: 11 }}>
            {e.totals?.amount ?? '—'} all time
          </span>
        </div>
        {e.by_week.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            No payment has been recorded in the last twelve weeks. That is a counted zero — the query ran and found
            nothing — not a chart that failed to load.
          </div>
        ) : (
          <>
            <div className="tick-days" style={{ marginTop: 12, height: 70, alignItems: 'flex-end' }}>
              {e.by_week.map((w) => (
                <div
                  key={w.week}
                  className="tick-day"
                  style={{ width: 14, height: `${Math.max(3, (Number(w.base_units) / (max || 1)) * 70)}px` }}
                  title={`week of ${w.week} · ${w.payments} payment(s) · ${w.amount ?? w.base_units}`}
                />
              ))}
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
              {e.by_week_note}
            </div>
          </>
        )}
        {e.totals?.decimals_note ? (
          <div className="am" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
            {e.totals.decimals_note}
          </div>
        ) : null}
        {e.other_tokens_note ? (
          <div className="am" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
            {e.other_tokens_note}
          </div>
        ) : null}
      </div>

      <div className="box">
        <Key>Recent payments</Key>
        {e.recent.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            No verified payment has ever been recorded against your wallet.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8, fontSize: 11.5 }}>
              <tbody>
                {e.recent.slice(0, 8).map((r) => (
                  <tr key={r.tx_hash}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>
                      {r.block_time ? utcDate(r.block_time) : '—'}
                    </td>
                    <td className="mono" title={r.buyer_wallet}>
                      {addr(r.buyer_wallet)}
                    </td>
                    <td>
                      {r.agent_id ? (
                        <Link href={`/me/agents/${r.agent_id}`}>{r.agent_name}</Link>
                      ) : (
                        <span className="m3">listing not found</span>
                      )}
                    </td>
                    <td className="mono r">{r.amount ?? r.base_units}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {e.subscribers ? (
          <div className="m3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.45 }}>
            {e.subscribers.note}
          </div>
        ) : null}
      </div>
    </div>
  );
}
