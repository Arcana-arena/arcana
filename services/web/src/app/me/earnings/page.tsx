/**
 * Earnings — what this creator has been paid, who subscribes, and the
 * reputation their agents' sealed scores add up to.
 *
 * MOVED, NOT COPIED. These figures used to sit on the dashboard between an
 * owner and their agents. They live here now and only here: the same numbers on
 * two surfaces is how they drift.
 *
 * A WEEK WITH NO PAYMENT IS ABSENT, not a zero bar. The service returns only the
 * weeks that happened, and drawing the gaps would claim the platform was running
 * and earning nothing in a week before this creator existed.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { int, num, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key } from '@/components/ds/primitives';
import { Callout, Failed, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../CreatorNav';
import type { Dashboard, Earnings } from '../shapes';

export const dynamic = 'force-dynamic';

export default async function EarningsPage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fearnings');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared.
        </StatusBox>
      </Shell>
    );
  }
  const { creator_id } = s.session;
  if (!creator_id) {
    return (
      <Shell>
        <h1>Earnings</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            <strong>This wallet has no creator profile yet</strong>, so nothing can have been earned.{' '}
            <Link href="/me">Set up your creator profile</Link> first.
          </Callout>
        </div>
      </Shell>
    );
  }

  const [dashR, earnR] = await Promise.all([
    authed<Dashboard>(`/v1/creators/${creator_id}/dashboard`),
    authed<Earnings>(`/v1/creators/${creator_id}/earnings`),
  ]);
  const d = dashR.ok ? dashR.data : null;
  const earnings = earnR.ok ? earnR.data : null;

  return (
    <Shell creatorId={creator_id} handle={d?.creator.handle}>
      <h1>Earnings</h1>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 4 }}>
        What buyers have paid you, who subscribes, and your reputation.
      </div>

      <section style={{ marginTop: 22 }}>
        <div className="stat-row">
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
              {!d || d.creator.reputation_score === null ? <span className="m3">—</span> : num(d.creator.reputation_score, 2)}
            </div>
            <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>
              {d?.creator.reputation?.status === 'measured'
                ? `mean performance of ${d.creator.reputation.agents} active agent(s), from sealed scores`
                : 'not measured — no active agent has a sealed score yet'}{' '}
              · <Link href={`/creators/${creator_id}`}>breakdown</Link>
            </div>
          </div>
        </div>

        {d && !d.creator.can_be_paid ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn">
              <strong>This creator has no wallet address, so nothing of yours can be bought.</strong> A listing
              without a payee refuses every quote and every claim — correctly, and after a buyer has already gone
              looking. Nothing on this platform can set it for you: it is the address money will go to.
            </Callout>
          </div>
        ) : null}
        {!dashR.ok ? (
          <div style={{ marginTop: 14 }}>
            <Failed what="Your reputation and payee state" error={{ ok: false, status: dashR.status, reason: dashR.reason, code: dashR.code }} />
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 28 }}>
        <EarningsPanel e={earnings} error={earnR.ok ? null : { status: earnR.status, reason: earnR.reason, code: earnR.code }} />
      </section>

      {d ? (
        <div className="mono m3" style={{ fontSize: 10.5, marginTop: 24 }}>
          read {utc(d.as_of)}
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({ children, creatorId, handle }: { children: React.ReactNode; creatorId?: string; handle?: string }) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current="Earnings" handle={handle} creatorId={creatorId} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}

function EarningsPanel({ e, error }: { e: Earnings | null; error: { status: number | null; reason: string; code: string | null } | null }) {
  if (error) {
    return (
      <>
        <Key>Payments</Key>
        <div style={{ marginTop: 8 }}>
          <Failed what="Your earnings" error={{ ok: false, status: error.status, reason: error.reason, code: error.code }} />
        </div>
      </>
    );
  }
  if (!e) return null;
  if (e.available === false) {
    return (
      <>
        <Key>Payments</Key>
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
        <Key>Payments</Key>
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
                      {r.buyer_wallet.slice(0, 6)}…{r.buyer_wallet.slice(-4)}
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
