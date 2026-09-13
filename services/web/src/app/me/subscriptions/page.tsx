/**
 * What is trading in my wallet, and whether it actually is.
 *
 * THE STATUS COLUMN IS NOT THE ANSWER. A subscription can read `active` and
 * still be doing nothing: its trading wallet may never have been derived, it
 * may be unfunded, or the buyer may have paused it themselves. So each card
 * shows the phase (active / grace / ended) AND whether the agent is trading,
 * and when those disagree it prints the service's one-sentence next step. A
 * buyer reading "active" and concluding their money is at work when it is not
 * is the failure this page is built against.
 *
 * GRACE IS DRAWN AS ITS OWN THING. During grace the agent opens nothing new
 * and armed stops still fire — which is exactly the state where a tidy
 * "expired" label would be wrong in both directions.
 *
 * THE RENEW PRICE IS TODAY'S, NOT THE ONE THAT WAS PAID. Creators change
 * prices, and a renew button quoting the old figure would send a buyer to
 * underpay — the one mistake this platform cannot undo. Where the two differ,
 * the card says so.
 *
 * POSITIONS COME FROM THE SUBSCRIPTION'S OWN BOOK, one read per active
 * subscription, so what is in the buyer's wallet is the buyer's wallet and not
 * the agent's.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ARCA_API } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { addr, int, money, num, pct, tone, txShort, utc, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Lbl, Num } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import type { MySubscription, SubscriptionBook } from '../../marketplace/shapes';
import { DeriveWallet } from './DeriveWallet';

export const dynamic = 'force-dynamic';

export default async function MySubscriptionsPage() {
  const s = await getSession();

  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fsubscriptions');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm who you are" bad>
          {s.reason}. You have not been signed out — a page that says so when the truth is that a service is down
          invites you to sign in again and again against nothing.
        </StatusBox>
      </Shell>
    );
  }

  const wallet = s.session.wallet_address;
  const subsR = await authed<MySubscription[]>(`/v1/subscriptions/${wallet}`, { base: ARCA_API });

  if (!subsR.ok) {
    return (
      <Shell wallet={wallet}>
        <Failed what="Your subscriptions" error={{ ok: false, status: subsR.status, reason: subsR.reason }} />
      </Shell>
    );
  }

  const subs = Array.isArray(subsR.data) ? subsR.data : [];

  // The book is only worth reading for subscriptions that have a wallet at all.
  // Asking for the rest would spend a round trip to be told there is nothing.
  const books = new Map<string, SubscriptionBook | { error: string }>();
  await Promise.all(
    subs
      .filter((x) => x.walletAddress)
      .map(async (x) => {
        const b = await authed<SubscriptionBook>(`/v1/subscriptions/${x.id}/book`);
        books.set(x.id, b.ok ? b.data : { error: `${b.status ?? ''} ${b.reason}`.trim() });
      }),
  );

  const active = subs.filter((x) => x.phase === 'active').length;
  const grace = subs.filter((x) => x.phase === 'grace').length;
  const tradingNow = subs.filter((x) => x.trading).length;

  return (
    <Shell wallet={wallet}>
      {subs.length === 0 ? (
        <Empty title="Nothing is trading in this wallet">
          You have no subscription. A subscribed agent trades in your own wallet, sized by your own limits —{' '}
          <Link href="/marketplace">the marketplace</Link> lists what is open.
        </Empty>
      ) : (
        <>
          <div className="m2" style={{ fontSize: 12.5, marginBottom: 18, lineHeight: 1.5 }}>
            <span className="mono">{int(subs.length)}</span> subscription{subs.length === 1 ? '' : 's'} ·{' '}
            <span className="mono">{int(active)}</span> active, <span className="mono">{int(grace)}</span> in grace ·{' '}
            <span className="mono">{int(tradingNow)}</span> actually trading for you right now.
            {tradingNow < active ? (
              <>
                {' '}
                <span className="am">
                  Fewer are trading than are active — the cards below say which and why.
                </span>
              </>
            ) : null}
          </div>

          <div className="sub-grid">
            {subs.map((x) => (
              <SubCard key={x.id} x={x} book={books.get(x.id) ?? null} />
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, wallet }: { children: React.ReactNode; wallet?: string }) {
  return (
    <div className="page">
      <Header />
      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <h1>My subscriptions</h1>
            {wallet ? (
              <div className="m2" style={{ fontSize: 12.5, marginTop: 4 }}>
                Wallet <span className="mono">{addr(wallet)}</span>
              </div>
            ) : null}
          </div>
          <Link href="/marketplace" style={{ fontSize: 12.5 }}>
            Browse the marketplace →
          </Link>
        </div>
      </div>
      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>{children}</div>
      <Footer />
    </div>
  );
}

function SubCard({ x, book }: { x: MySubscription; book: SubscriptionBook | { error: string } | null }) {
  const name = x.agent?.name ?? (x.agentId ? x.agentId.slice(0, 8) : null);
  const borderTone =
    x.phase === 'grace' ? 'rgba(212,162,74,.5)' : x.phase === 'ended' ? 'var(--color-divider)' : undefined;

  const holdings =
    book && 'book' in book && book.book ? Object.entries(book.book.holdings ?? {}).filter(([, q]) => Number(q) !== 0) : [];

  return (
    <article className="card" style={borderTone ? { borderColor: borderTone } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, lineHeight: 1 }}>
            {x.agentId ? <Link href={`/agents/${x.agentId}`}>{name}</Link> : <span className="m3">no agent</span>}
            {x.agent?.version ? (
              <span className="mono m3" style={{ fontWeight: 400, fontSize: 10 }}>
                {' '}
                v{x.agent.version}
              </span>
            ) : null}
          </div>
          <div className="m2" style={{ fontSize: 11.5, marginTop: 3 }}>
            {x.agent?.creator?.handle ?? <span className="m3">creator not recorded</span>} ·{' '}
            <PhaseTag phase={x.phase} />
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          {x.phase === 'active' ? (
            <>
              <div className="mono" style={{ fontSize: 22, lineHeight: 1 }}>
                {int(x.days_remaining)}d
              </div>
              <Lbl>REMAINING</Lbl>
            </>
          ) : x.phase === 'grace' ? (
            <>
              <div className="mono am" style={{ fontSize: 22, lineHeight: 1 }}>
                {int(x.grace_hours_remaining)}h
              </div>
              <Lbl>GRACE LEFT</Lbl>
            </>
          ) : (
            <>
              <div className="mono m3" style={{ fontSize: 22, lineHeight: 1 }}>
                —
              </div>
              <Lbl>ENDED {utcDate(x.expiresAt)}</Lbl>
            </>
          )}
        </div>
      </div>

      <TermBar x={x} />

      <dl className="kv">
        <dt>Expires</dt>
        <dd className="mono">{utc(x.expiresAt)}</dd>
        <dt>Grace ends</dt>
        <dd className={x.phase === 'grace' ? 'mono am' : 'mono'}>{utc(x.grace_ends_at)}</dd>
        {/* THE ADDRESS TO FUND. A wallet the buyer is told to fund and cannot
            see is one nobody funds — the card said "trading" while showing no
            address anywhere on the page. */}
        {x.walletAddress ? (
          <>
            <dt>Trading wallet</dt>
            <dd className="mono brk">{x.walletAddress}</dd>
          </>
        ) : null}
        <dt>Receipt</dt>
        <dd className="mono">
          {x.receipt ? (
            <span title={x.receipt.tx_hash}>
              {txShort(x.receipt.tx_hash)} · block {x.receipt.block_number}
            </span>
          ) : (
            <span className="m3" title={x.receipt_note ?? undefined}>
              no verified payment on record
            </span>
          )}
        </dd>
        <dt>Wallet P&amp;L</dt>
        <dd>
          {x.wallet_pnl.computable ? (
            <>
              <Num value={money(x.wallet_pnl.pnl)} tone={tone(x.wallet_pnl.pnl)} />{' '}
              <span className={`mono ${tone(x.wallet_pnl.pnl_pct)}`} style={{ fontSize: 11 }}>
                {pct(x.wallet_pnl.pnl_pct)}
              </span>
            </>
          ) : (
            <span className="mono m3" title={x.wallet_pnl.reason ?? undefined}>
              not computable
            </span>
          )}
        </dd>
      </dl>

      {/* THE SENTENCE THAT SAYS WHETHER ANYTHING IS ACTUALLY HAPPENING. It is
          the service's own, and it is never "everything is fine" when it is
          not. */}
      {!x.trading ? (
        <Callout tone={x.phase === 'ended' ? 'note' : 'warn'}>{x.next_step}</Callout>
      ) : (
        <div className="m3" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          {x.next_step}
        </div>
      )}

      {x.phase === 'grace' ? (
        <Callout tone="warn">
          <strong>In grace.</strong> The agent will not open new positions in your wallet, and armed stops still fire.
          Renew to resume; after grace, whatever is open stays yours to manage.
        </Callout>
      ) : null}

      <div>
        <Lbl>POSITIONS IN MY WALLET{holdings.length > 0 ? ` · ${holdings.length}` : ''}</Lbl>
        {!x.walletAddress ? (
          <>
            <div className="m3" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
              This subscription has no trading wallet yet, so there is nothing to hold. Not an empty book — no book.
            </div>
            <DeriveWallet subscriptionId={x.id} />
          </>
        ) : book && 'error' in book ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            The book could not be read ({book.error}). Nothing is listed rather than an empty list, which would say you
            hold nothing.
          </div>
        ) : holdings.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 4 }}>
            {book && 'book' in book && book.book
              ? 'The last recorded snapshot of this wallet was all cash. A recorded zero, not a missing reading.'
              : 'No snapshot of this wallet has been recorded yet.'}
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 11.5, marginTop: 4, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
            {holdings.map(([sym, qty]) => (
              <div key={sym} style={{ display: 'contents' }}>
                <span>{sym}</span>
                <span className="m2">{num(Number(qty), 6)}</span>
              </div>
            ))}
          </div>
        )}
        {book && 'book' in book && book.book ? (
          <div className="mono m3" style={{ fontSize: 10.5, marginTop: 6 }}>
            NAV {money(book.book.nav)} · cash {money(book.book.cash)} · read {utc(book.book.as_of)}
          </div>
        ) : null}
      </div>

      {book && 'protection' in book && book.protection.unprotected.length > 0 ? (
        <Callout tone="bad">
          <strong>
            {book.protection.unprotected.length} protective level{book.protection.unprotected.length === 1 ? '' : 's'}{' '}
            refused.
          </strong>{' '}
          {book.protection.note}
        </Callout>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
        {x.listingId ? (
          <Link
            href={`/marketplace/${x.listingId}`}
            className={x.phase === 'active' ? 'btn' : 'btn btn-primary'}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {x.phase === 'active' ? 'Extend' : x.phase === 'grace' ? 'Renew' : 'Resubscribe'}
            {x.listing?.price_usd_now !== null && x.listing?.price_usd_now !== undefined
              ? ` · ${money(x.listing.price_usd_now)}`
              : ''}
          </Link>
        ) : (
          <span className="m3" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            This subscription names no listing, so there is nothing to renew against.
          </span>
        )}
        {x.agentId ? (
          <Link href={`/agents/${x.agentId}?tab=positions`} className="btn btn-ghost">
            Log
          </Link>
        ) : null}
      </div>
      {x.listing && x.listing.active === false ? (
        <div className="m3" style={{ fontSize: 11 }}>
          The listing is switched off. Whatever is open in your wallet stays yours; a renewal is not available while it
          is off.
        </div>
      ) : null}
    </article>
  );
}

function PhaseTag({ phase }: { phase: 'active' | 'grace' | 'ended' }) {
  if (phase === 'active') return <span className="up">ACTIVE</span>;
  if (phase === 'grace') return <span className="am">GRACE PERIOD</span>;
  return <span className="m3">ENDED</span>;
}

/**
 * How much of the term is used, drawn from the term the service reported.
 *
 * The width is presentation over two timestamps the service sent; it is not a
 * second opinion about when the term ends. A bar with no term to measure is
 * drawn empty rather than full.
 */
function TermBar({ x }: { x: MySubscription }) {
  const end = Date.parse(x.expiresAt);
  const start = end - x.term_days * 86400000;
  const now = Date.now();
  const used = Number.isFinite(start) && end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 0;
  if (x.phase === 'ended') return <div className="progress" />;
  if (x.phase === 'grace') {
    const graceEnd = Date.parse(x.grace_ends_at);
    const gUsed = graceEnd > end ? Math.max(0, Math.min(1, (now - end) / (graceEnd - end))) : 1;
    return (
      <div className="progress">
        <div className="fill" style={{ width: '100%', background: 'var(--ink-3)' }} />
        <div className="fill" style={{ left: 'auto', right: 0, width: `${((1 - gUsed) * 25).toFixed(1)}%`, background: 'var(--amber)' }} />
      </div>
    );
  }
  return (
    <div className="progress">
      <div className="fill" style={{ width: `${(used * 100).toFixed(1)}%` }} />
    </div>
  );
}
