'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deriveSubscriptionWallet } from './actions';

/**
 * The button between "Access granted" and a subscription that actually trades.
 *
 * It sends the subscription id and nothing else — the address comes back from
 * the signer, derived from that id. A refusal is shown in the service's words,
 * never as a generic failure.
 */
export function DeriveWallet({ subscriptionId }: { subscriptionId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setFail(null);
            const r = await deriveSubscriptionWallet(subscriptionId);
            if (r.ok) router.refresh();
            else setFail(`${r.status ?? ''} ${r.reason}`.trim());
          })
        }
      >
        {pending ? 'Deriving…' : 'Create trading wallet'}
      </button>
      <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
        The address is derived by the signer from this subscription&rsquo;s id. Fund it yourself — USDG to trade, ETH for
        gas. Nothing trades until it is funded.
      </div>
      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 8 }}>
          The wallet was not created: {fail}
        </div>
      ) : null}
    </div>
  );
}
