'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { publishListing, updateListing } from './actions';

/**
 * Put an agent on the marketplace, or take it off.
 *
 * THE REFUSAL THAT MATTERS IS `creator_has_no_wallet`, and it is shown as what
 * it is rather than as "could not save". A listing whose creator has no payee
 * address refuses every quote and every claim — correctly, and after a buyer
 * has already gone looking — so the service refuses to publish one at all. The
 * thing to fix is the creator's wallet, and the owner is told that.
 *
 * SWITCHING A LISTING OFF DOES NOT END ANYBODY'S SUBSCRIPTION. Somebody who has
 * paid keeps their term; what stops is new buyers. Saying so here is the
 * difference between a toggle somebody flips and a toggle somebody flips
 * believing it cancels their obligations.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

export function ListingPanel({
  agentId,
  listing,
  agentStatus,
  creatorCanBePaid,
}: {
  agentId: string;
  listing: { id: string; priceUsd: number | null; active: boolean; subscribersActive: number } | null;
  agentStatus: string;
  creatorCanBePaid: boolean | null;
}) {
  const router = useRouter();
  const [price, setPrice] = useState(listing?.priceUsd != null ? String(listing.priceUsd) : '25.00');
  const [fail, setFail] = useState<Fail | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: true; data: unknown } | Fail>) => {
    setFail(null);
    start(async () => {
      const r = await fn();
      if (r.ok) router.refresh();
      else setFail(r);
    });
  };

  const priceNum = Number(price);
  const priceOk = Number.isFinite(priceNum) && priceNum >= 0;

  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="k">Marketplace listing</span>
        {listing ? (
          <span className={listing.active ? 'up' : 'm3'} style={{ fontSize: 11 }}>
            {listing.active ? 'on sale' : 'switched off'}
          </span>
        ) : (
          <span className="m3" style={{ fontSize: 11 }}>
            not listed
          </span>
        )}
      </div>

      {creatorCanBePaid === false ? (
        <div className="callout callout-warn" style={{ marginTop: 10 }}>
          <strong>Nothing of yours can be listed until your creator profile has a wallet address.</strong> There would
          be no address a buyer could pay and none the platform could check a payment against, so publishing is
          refused rather than allowed and then broken. Nothing on this surface can set it for you — it is the address
          money will go to.
        </div>
      ) : null}

      {agentStatus === 'retired' ? (
        <div className="m3" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
          A retired agent makes no decisions, so a subscription to it would mirror nothing into a buyer&rsquo;s
          wallet. Its listing, if it has one, is not on sale.
        </div>
      ) : null}

      {listing ? (
        <>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
            {listing.priceUsd !== null ? (
              <>
                <span className="mono">{listing.priceUsd}</span> per term ·{' '}
              </>
            ) : null}
            <span className="mono">{listing.subscribersActive}</span> active subscriber
            {listing.subscribersActive === 1 ? '' : 's'}
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="price">Price</label>
            <input
              id="price"
              className="input mono"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              style={{ width: 160 }}
            />
            <div className="help">
              A price change applies to NEW purchases. Anyone already subscribed keeps the term they paid for, and
              their renewal is quoted at whatever this says on the day they renew.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={pending || !priceOk}
              onClick={() => run(() => updateListing(agentId, listing.id, { priceUsd: priceNum }))}
            >
              {pending ? 'Saving…' : 'Save price'}
            </button>
            <button
              className="btn"
              disabled={pending}
              onClick={() => run(() => updateListing(agentId, listing.id, { active: !listing.active }))}
            >
              {listing.active ? 'Take off sale' : 'Put back on sale'}
            </button>
            <Link href={`/marketplace/${listing.id}`} className="btn btn-ghost">
              See the listing →
            </Link>
          </div>

          {listing.active && listing.subscribersActive > 0 ? (
            <div className="m3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}>
              Taking it off sale stops NEW buyers. It does not end anybody&rsquo;s subscription and does not refund
              anyone — the {listing.subscribersActive} wallet
              {listing.subscribersActive === 1 ? '' : 's'} already subscribed keep their term, and the agent goes on
              trading for them.
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="newprice">Price per term</label>
            <input
              id="newprice"
              className="input mono"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              style={{ width: 160 }}
            />
            <div className="help">
              What a buyer sends you directly. ARCANA never receives it, takes no fee, and cannot refund it — which
              is why it cannot be recovered if somebody sends the wrong amount.
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            disabled={pending || !priceOk || agentStatus === 'retired' || creatorCanBePaid === false}
            onClick={() => run(() => publishListing(agentId, priceNum))}
          >
            {pending ? 'Publishing…' : 'List on the marketplace'}
          </button>
        </>
      )}

      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 12 }}>
          <strong>
            {fail.code === 'creator_has_no_wallet'
              ? 'Your creator profile has no wallet address'
              : (fail.code ?? `The service answered ${fail.status ?? 'nothing'}`)}
          </strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </section>
  );
}
