'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { claimPayment, findUnclaimed } from './actions';
import type { ClaimOutcome, Quote, Unclaimed } from '../shapes';

/**
 * The five steps between deciding to subscribe and being subscribed — and the
 * three ways it goes wrong.
 *
 * THE NO-REFUND WARNING IS ON STEP ONE. That is not a layout preference. The
 * buyer pays the creator directly; ARCANA never holds the money and cannot
 * return it. Step one is the last moment they can still decide, so the warning
 * lives there and the button is disabled until it has been acknowledged. Every
 * later step is after the point of no return, and a warning shown there is a
 * confession rather than a disclosure.
 *
 * EVERY FIGURE ON THIS PANEL COMES FROM THE QUOTE. The address, the amount, the
 * decimals, the term, the grace window and the confirmation depth are all
 * resolved by the service that verifies the payment — the same call, not a
 * parallel one that agrees today. A second conversion in this component is
 * exactly how a buyer gets shown one address and checked against another.
 *
 * THE THREE FAILURES ARE THREE SCREENS, not one. "Payment failed" tells a
 * person who has just irreversibly sent money nothing they can act on:
 *
 *   amount short      what arrived, what was owed, the difference — and a
 *                     remedy that says what actually works, which is NOT
 *                     "send the difference and we will match them"
 *   wrong recipient   the addresses the transfer actually reached, beside the
 *                     one it should have
 *   hash already used what it bought, when, and whether that term still runs
 *
 * "VERIFYING" IS A WAIT, NOT A FAILURE. Too few confirmations comes back with
 * `pending: true` and the counts, so this draws progress instead of an error.
 */

type Step = 'quote' | 'transfer' | 'hash' | 'result';

export function SubscribeFlow({
  listingId,
  agentName,
  quote,
  quoteError,
  signedIn,
  signInHref,
}: {
  listingId: string;
  agentName: string;
  quote: Quote | null;
  quoteError: string | null;
  signedIn: boolean;
  signInHref: string;
}) {
  const [step, setStep] = useState<Step>('quote');
  const [ack, setAck] = useState(false);
  const [hash, setHash] = useState('');
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null);
  const [unclaimed, setUnclaimed] = useState<Unclaimed | null>(null);
  const [unclaimedError, setUnclaimedError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // A clipboard that refuses is not an error worth a dialog — the value is
      // on the page in full and selectable. Saying nothing beats a modal.
      setCopied(null);
    }
  };

  const submit = () => {
    start(async () => {
      const r = await claimPayment(listingId, hash);
      setOutcome(r);
      setStep('result');
    });
  };

  const lookUnclaimed = () => {
    start(async () => {
      const r = await findUnclaimed(listingId);
      if (r.ok) {
        setUnclaimed(r.data);
        setUnclaimedError(null);
      } else {
        setUnclaimed(null);
        setUnclaimedError(`${r.status ?? ''} ${r.reason}`.trim());
      }
    });
  };

  // ---- the panel cannot be used at all --------------------------------
  if (!quote) {
    return (
      <aside className="blueprint panel">
        <StepBar step="quote" />
        <div className="k" style={{ marginBottom: 6 }}>
          No quote can be stated
        </div>
        <p className="m2" style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
          {quoteError ??
            'The service did not return an amount or a payee for this listing, so this page will not name one.'}
        </p>
        <div
          className="mono m3"
          style={{ fontSize: 11, marginTop: 12, lineHeight: 1.5, borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}
        >
          Do not send anything. An address guessed from anywhere else is the exact mistake this endpoint exists to
          prevent — ARCANA never receives the money and could not return it.
        </div>
      </aside>
    );
  }

  if (!signedIn) {
    return (
      <aside className="blueprint panel">
        <StepBar step="quote" />
        <QuoteBody quote={quote} agentName={agentName} />
        <div className="callout callout-note" style={{ marginTop: 14 }}>
          Subscribing needs a signed-in wallet, because the payment is matched against the wallet that sent it. Reading
          this listing does not.
        </div>
        <Link href={signInHref} className="btn btn-primary" style={{ marginTop: 12, justifyContent: 'center' }}>
          Sign in to subscribe
        </Link>
      </aside>
    );
  }

  return (
    <aside className="blueprint panel">
      <StepBar step={step} outcome={outcome} />

      {step === 'quote' ? (
        <>
          <QuoteBody quote={quote} agentName={agentName} />
          {/* THE WARNING, BEFORE THE MONEY MOVES. Its wording is the service's
              own — the same sentence the API returns with the quote, so a
              buyer and a support conversation are reading one text. */}
          <div className="callout callout-bad" style={{ marginTop: 16 }}>
            <strong>No refunds.</strong> {quote.warning}
          </div>
          <label
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, marginTop: 14, color: 'var(--ink-2)' }}
          >
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
            I understand the payment is final, that ARCANA never receives it, and that this agent will trade in my
            wallet.
          </label>
          <button
            className="btn btn-primary"
            style={{ marginTop: 14, width: '100%', justifyContent: 'center', opacity: ack ? 1 : 0.45 }}
            disabled={!ack}
            onClick={() => setStep('transfer')}
          >
            Continue to transfer
          </button>
        </>
      ) : null}

      {step === 'transfer' ? (
        <>
          <div className="k" style={{ marginBottom: 6 }}>
            Awaiting your transfer
          </div>
          <p className="m2" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            Send exactly <span className="mono" style={{ color: 'var(--color-text)' }}>{quote.amount}</span> of the
            token below, from the wallet you signed in with. A transfer from any other wallet will not be matched to
            you — the sender is checked against your session, which is what stops somebody else claiming your payment.
          </p>

          <div style={{ marginTop: 16 }}>
            <div className="lbl" style={{ marginBottom: 4 }}>
              RECIPIENT
            </div>
            <div className="mono addr-box">{quote.pay_to}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => copy('address', quote.pay_to)}>
                {copied === 'address' ? 'Copied' : 'Copy address'}
              </button>
              <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => copy('amount', quote.amount)}>
                {copied === 'amount' ? 'Copied' : 'Copy amount'}
              </button>
            </div>

            <div className="lbl" style={{ margin: '14px 0 4px' }}>
              TOKEN
            </div>
            <div className="mono addr-box">{quote.token}</div>
            <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
              Checked by address, never by symbol. Anyone can deploy a token that calls itself the right thing; the
              address is the only part that cannot be forged.
            </div>

            <div className="lbl" style={{ margin: '14px 0 4px' }}>
              AMOUNT
            </div>
            <div className="mono" style={{ fontSize: 16 }}>
              {quote.amount}{' '}
              <span className="m3" style={{ fontSize: 11 }}>
                · {quote.amount_base_units} base units at {quote.decimals} decimals
              </span>
            </div>
          </div>

          <div
            className="m2"
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--color-divider)', fontSize: 12 }}
          >
            Nothing is watching the chain for you. Submit the hash yourself once the transfer is sent.
          </div>
          <button className="btn" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={() => setStep('hash')}>
            I&rsquo;ve sent it — paste the tx hash
          </button>
          <button className="btn-link" style={{ marginTop: 8 }} onClick={() => setStep('quote')}>
            ← back to the quote
          </button>
        </>
      ) : null}

      {step === 'hash' ? (
        <>
          <div className="k" style={{ marginBottom: 6 }}>
            Paste the transaction hash
          </div>
          <p className="m2" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            Find it in your wallet&rsquo;s activity or on the explorer. It starts with <span className="mono">0x</span>{' '}
            and is 66 characters long.
          </p>
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="txhash">Transaction hash</label>
            <input
              id="txhash"
              className="input mono"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              style={{ width: '100%', fontSize: 12 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
              <HashHint value={hash} />
              <span className="m3 mono">{hash.trim().length} / 66</span>
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'Checking the chain…' : 'Verify payment'}
          </button>

          <div className="m3" style={{ fontSize: 11.5, marginTop: 14, lineHeight: 1.5 }}>
            Lost the hash? ARCANA can look for a recent transfer from your wallet to this creator.{' '}
            <button className="btn-link" onClick={lookUnclaimed} disabled={pending}>
              Search for it
            </button>
          </div>
          {unclaimedError ? (
            <div className="callout callout-bad" style={{ marginTop: 10 }}>
              The search could not be run: {unclaimedError}. That is not a statement about whether you paid.
            </div>
          ) : null}
          {unclaimed ? <UnclaimedList u={unclaimed} onPick={(h) => setHash(h)} /> : null}
          <button className="btn-link" style={{ marginTop: 10 }} onClick={() => setStep('transfer')}>
            ← back to the transfer details
          </button>
        </>
      ) : null}

      {step === 'result' && outcome ? (
        <Result
          outcome={outcome}
          quote={quote}
          agentName={agentName}
          onRetry={() => {
            setOutcome(null);
            setStep('hash');
          }}
        />
      ) : null}
    </aside>
  );
}

/**
 * The step rail.
 *
 * A FAILED STEP IS COLOURED AND NAMED, not skipped over. The design puts
 * "4 FAILED" where "4 VERIFY" was, and that is right: a rail that keeps
 * marching forward through a failure tells the reader they are further along
 * than they are.
 */
function StepBar({ step, outcome }: { step: Step; outcome?: ClaimOutcome | null }) {
  const failedAtHash = outcome?.kind === 'already_used';
  const failed = outcome && outcome.kind !== 'granted' && outcome.kind !== 'pending';
  const granted = outcome?.kind === 'granted';
  const waiting = outcome?.kind === 'pending';

  const idx = step === 'quote' ? 0 : step === 'transfer' ? 1 : step === 'hash' ? 2 : granted ? 4 : 3;
  const labels = [
    '1 QUOTE',
    '2 TRANSFER',
    failedAtHash ? '3 REJECTED' : '3 HASH',
    failed && !failedAtHash ? '4 FAILED' : waiting ? '4 WAITING' : '4 VERIFY',
    '5 DONE',
  ];
  return (
    <div className="steps">
      {labels.map((l, i) => {
        const bad = (failedAtHash && i === 2) || (failed && !failedAtHash && i === 3);
        const on = i === idx;
        return (
          <span key={l} className={bad ? 'step-bad' : on ? 'on' : i < idx ? 'done' : ''}>
            {l}
          </span>
        );
      })}
    </div>
  );
}

function QuoteBody({ quote, agentName }: { quote: Quote; agentName: string }) {
  return (
    <>
      <div className="k" style={{ marginBottom: 6 }}>
        Subscription quote
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="mono" style={{ fontSize: 34, fontWeight: 500 }}>
          {quote.amount}
        </span>
        <span className="m2">
          · {quote.term_days} days
        </span>
      </div>
      <div className="mono m3" style={{ fontSize: 11, marginTop: 2 }}>
        the amount and the payee are resolved by the same code that verifies the payment
      </div>
      <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
        <dt>Pay to</dt>
        <dd className="mono brk">{quote.pay_to}</dd>
        <dt>Token</dt>
        <dd className="mono brk">{quote.token}</dd>
        <dt>Exact amount</dt>
        <dd className="mono">{quote.amount}</dd>
        <dt>Term</dt>
        <dd className="mono">
          {quote.term_days}d from confirmation, then {quote.grace_hours}h grace
        </dd>
        <dt>Claim within</dt>
        <dd className="mono">{quote.claim_within_hours}h of the transfer</dd>
        <dt>Confirmations</dt>
        <dd className="mono">{quote.min_confirmations}</dd>
        <dt>Buys</dt>
        <dd>{agentName} trades in your own wallet, sized by your own limits</dd>
      </dl>
    </>
  );
}

function HashHint({ value }: { value: string }) {
  const v = value.trim();
  if (v.length === 0) return <span className="m3">nothing pasted yet</span>;
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return <span className="up">valid format · 66 chars</span>;
  if (!v.startsWith('0x')) return <span className="dn">a transaction hash starts with 0x</span>;
  return <span className="am">not 66 characters yet — this is a format check, not a check of the payment</span>;
}

function UnclaimedList({ u, onPick }: { u: Unclaimed; onPick: (hash: string) => void }) {
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
      <div className="k" style={{ marginBottom: 6 }}>
        Unclaimed transfers from your wallet
      </div>
      {u.candidates.length === 0 ? (
        <div className="m2" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Nothing found in the searched window. That is not &ldquo;you did not pay&rdquo; — {u.note}
        </div>
      ) : (
        <>
          {u.candidates.map((c) => (
            <div
              key={c.tx_hash}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--color-divider)' }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                  {c.tx_hash}
                </div>
                <div className={c.sufficient ? 'mono up' : 'mono dn'} style={{ fontSize: 11 }}>
                  {c.amount_base_units} base units · {c.sufficient ? 'covers the quote' : 'does NOT cover the quote'}
                </div>
              </div>
              <button className="btn" style={{ fontSize: 12, padding: '4px 10px', flex: 'none' }} onClick={() => onPick(c.tx_hash)}>
                Use
              </button>
            </div>
          ))}
          <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
            {u.note}
          </div>
        </>
      )}
    </div>
  );
}

/** The five outcomes, each drawn as what it actually is. */
function Result({
  outcome,
  quote,
  agentName,
  onRetry,
}: {
  outcome: ClaimOutcome;
  quote: Quote;
  agentName: string;
  onRetry: () => void;
}) {
  if (outcome.kind === 'granted') {
    const d = outcome.data;
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="mark mark-ok">✓</span>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20 }}>Access granted</div>
            <div className="m2" style={{ fontSize: 12 }}>
              {agentName} now trades for your wallet
            </div>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
          <dt>Expires</dt>
          <dd className="mono">{new Date(d.expires_at).toISOString().replace('T', ' ').slice(0, 19)}Z</dd>
          <dt>Grace until</dt>
          <dd className="mono">
            {new Date(new Date(d.expires_at).getTime() + quote.grace_hours * 3600000)
              .toISOString()
              .replace('T', ' ')
              .slice(0, 19)}
            Z
          </dd>
          <dt>Confirmations</dt>
          <dd className="mono">{d.confirmations}</dd>
          <dt>Receipt</dt>
          <dd className="mono brk">{d.tx_hash}</dd>
        </dl>
        {/* THE ONE THING THAT STILL NEEDS DOING. A subscription with no trading
            wallet is one nothing ever happens in — the buyer pays, everything
            works, and their wallet stays empty. Said here rather than
            discovered later. */}
        <div className="callout callout-warn" style={{ marginTop: 16 }}>
          <strong>Two things before the first tick.</strong> Derive this subscription&rsquo;s trading wallet and fund
          it — the agent never spends anybody else&rsquo;s money, so until it is funded nothing happens. Then set your
          own protective levels; the creator chooses direction only.
        </div>
        <Link href="/me/subscriptions" className="btn btn-primary" style={{ marginTop: 14, justifyContent: 'center' }}>
          My subscriptions
        </Link>
      </>
    );
  }

  if (outcome.kind === 'pending') {
    const b = outcome.body;
    const done = Math.max(0, Math.min(b.required_confirmations, b.confirmations));
    const pctDone = b.required_confirmations > 0 ? (done / b.required_confirmations) * 100 : 0;
    return (
      <>
        <div className="k" style={{ marginBottom: 6 }}>
          Verifying
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <span className="spin" />
          <div>
            <div style={{ fontSize: 14 }}>Waiting for confirmations</div>
            <div className="mono am" style={{ fontSize: 12 }}>
              {b.confirmations} / {b.required_confirmations} · about {b.estimated_seconds_remaining}s remaining
            </div>
          </div>
        </div>
        <div className="conf-bar" style={{ marginTop: 14 }} aria-hidden>
          <div style={{ width: `${pctDone.toFixed(1)}%` }} />
        </div>
        <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
          <dt>Block</dt>
          <dd className="mono">{b.block_number}</dd>
          <dt>Chain head</dt>
          <dd className="mono">{b.chain_head}</dd>
        </dl>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
          Nothing is wrong with this payment. It has been mined and is not yet deep enough to be treated as final.
          Check again in a moment — the same hash is the right one.
        </div>
        <button className="btn btn-primary" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onRetry}>
          Check again
        </button>
      </>
    );
  }

  if (outcome.kind === 'short') {
    const b = outcome.body;
    return (
      <>
        <FailHead title="Amount too low" sub="The transfer confirmed and does not cover the quote" />
        <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
          <dt>Received</dt>
          <dd className="mono dn">{b.paid ?? `${b.paid_base_units} base units`}</dd>
          <dt>Quoted</dt>
          <dd className="mono">{b.required ?? `${b.required_base_units} base units`}</dd>
          <dt>Short by</dt>
          <dd className="mono dn">{b.shortfall ?? `${b.shortfall_base_units} base units`}</dd>
          <dt>Tx</dt>
          <dd className="mono brk">{b.tx_hash}</dd>
        </dl>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
          {b.remedy}
        </div>
        <button className="btn" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onRetry}>
          Submit a different hash
        </button>
      </>
    );
  }

  if (outcome.kind === 'wrong_recipient') {
    const b = outcome.body;
    const wrong = b.transfers.filter((t) => t.right_token && !t.right_recipient);
    return (
      <>
        <FailHead
          title={b.wrong_recipient ? 'Wrong recipient' : 'No matching transfer'}
          sub={
            b.wrong_recipient
              ? 'This transfer did not go to the creator’s wallet'
              : 'This transaction moved nothing that could pay for this listing'
          }
        />
        <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
          {wrong.length > 0 ? (
            <>
              <dt>Sent to</dt>
              <dd className="mono dn brk">{wrong.map((t) => t.to).join(', ')}</dd>
            </>
          ) : null}
          <dt>Expected</dt>
          <dd className="mono up brk">{b.expected_recipient}</dd>
          <dt>Expected token</dt>
          <dd className="mono brk">{b.expected_token}</dd>
        </dl>
        {b.transfers.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div className="lbl" style={{ marginBottom: 4 }}>
              WHAT THIS TRANSACTION ACTUALLY MOVED
            </div>
            {b.transfers.map((t, n) => (
              <div key={n} className="mono" style={{ fontSize: 11, lineHeight: 1.5, wordBreak: 'break-all', marginTop: 4 }}>
                <span className={t.right_token ? 'up' : 'dn'}>{t.right_token ? 'right token' : 'other token'}</span>
                {' · '}
                <span className={t.right_recipient ? 'up' : 'dn'}>
                  {t.right_recipient ? 'right recipient' : 'other recipient'}
                </span>
                {' · '}
                {t.amount ?? `${t.amount_base_units} base units`} → {t.to}
              </div>
            ))}
          </div>
        ) : (
          <div className="m2" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
            This transaction moved no token at all. It may be the hash of something unrelated.
          </div>
        )}
        <div className="dn" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
          ARCANA does not control the receiving address and cannot recover these funds. If you typed the address, check
          it for a look-alike before sending anything else.
        </div>
        <button className="btn" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onRetry}>
          Submit a different hash
        </button>
      </>
    );
  }

  if (outcome.kind === 'already_used') {
    const b = outcome.body;
    return (
      <>
        <FailHead
          title="Hash already used"
          sub={
            b.claimed_agent_name
              ? `This transaction already paid for ${b.claimed_agent_name}`
              : 'This transaction already paid for a listing'
          }
        />
        <dl className="kv" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
          <dt>Tx</dt>
          <dd className="mono brk">{b.tx_hash}</dd>
          <dt>Bought</dt>
          <dd className="mono">
            {b.claimed_agent_name ?? b.claimed_listing_id}
            {b.claimed_creator_handle ? ` · ${b.claimed_creator_handle}` : ''}
          </dd>
          <dt>Claimed</dt>
          <dd className="mono">{b.claimed_at ? b.claimed_at.replace('T', ' ').slice(0, 19) + 'Z' : '—'}</dd>
          <dt>By wallet</dt>
          <dd className="mono brk">{b.claimed_by_wallet}</dd>
          {b.term ? (
            <>
              <dt>That term</dt>
              <dd className="mono">
                expires {b.term.expires_at.slice(0, 10)}
                {b.term.in_grace ? <span className="am"> · in grace</span> : null}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
          Each hash can be claimed once. {b.remedy}
        </div>
        <button className="btn" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onRetry}>
          Paste a different hash
        </button>
      </>
    );
  }

  // Everything else — including "the chain could not be read", which is NOT a
  // verdict on the payment and must not be drawn as one.
  const unknown = outcome.code === 'payment_verification_unavailable';
  return (
    <>
      <FailHead
        title={unknown ? 'Nothing was checked' : 'The claim was refused'}
        sub={unknown ? 'This is not a judgement about your transaction' : (outcome.code ?? 'no code was returned')}
        tone={unknown ? 'amber' : 'red'}
      />
      <div className="m2" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
        {outcome.reason}
      </div>
      <button className="btn" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} onClick={onRetry}>
        Try again
      </button>
    </>
  );
}

function FailHead({ title, sub, tone = 'red' }: { title: string; sub: string; tone?: 'red' | 'amber' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span className={tone === 'amber' ? 'mark mark-warn' : 'mark mark-bad'}>✕</span>
      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20 }}>{title}</div>
        <div className="m2" style={{ fontSize: 12 }}>
          {sub}
        </div>
      </div>
    </div>
  );
}
