'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSiweMessage } from 'viem/siwe';

/**
 * Sign in with a wallet, and refuse to do it dishonestly.
 *
 * THE DOMAIN CHECK IS THE POINT OF THIS COMPONENT, not a nicety. EIP-4361 puts
 * the requesting site's domain inside the text the wallet shows you, so that a
 * page on evil.example cannot get you to sign something that reads
 * "arcana.xyz wants you to sign in". The server matches that field EXACTLY
 * against AUTH_SIWE_DOMAIN and rejects anything else — which is the check
 * working.
 *
 * So when this page's configured SIWE domain does not equal the host the
 * browser is actually on, it does NOT sign. It says what the mismatch is. The
 * alternative — signing a message naming a domain the user is not visiting —
 * teaches people to click through the exact warning the standard exists to
 * give them, and the day that habit matters is the day it costs them a wallet.
 *
 * THE PRIVATE KEY NEVER LEAVES THE WALLET. This asks for a signature over a
 * message; it does not ask for, receive or store a key, and the only things
 * that cross the wire are the message and the signature.
 *
 * The token pair never reaches this component either: /api/session receives it
 * and puts it in httpOnly cookies. Nothing on this origin can read it.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

// THESE ARRIVE AS PROPS, NOT AS NEXT_PUBLIC_ ENV VARS. NEXT_PUBLIC_* is inlined
// at build time, which would make one build unable to serve two origins and
// would tie the sign-in domain to whoever ran npm run build. The server reads
// its own configuration at request time and hands it down, so this page is
// always comparing the host it is on against what the service will actually
// accept.
export type SiweParams = { domain: string; uri: string; chainId: number };

function injected(): Eip1193 | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { ethereum?: Eip1193 };
  return w.ethereum ?? null;
}

export function SignInForm({ next, siwe }: { next: string; siwe: SiweParams }) {
  const SIWE_DOMAIN = siwe.domain;
  const SIWE_URI = siwe.uri;
  const CHAIN_ID = siwe.chainId;
  const router = useRouter();
  const [host, setHost] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHost(window.location.host);
    setHasWallet(injected() !== null);
  }, []);

  const domainMatches = host !== null && SIWE_DOMAIN !== '' && SIWE_DOMAIN === host;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const eth = injected();
      if (!eth) throw new Error('no wallet is injected into this page');

      setStep('asking the wallet which account to use');
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error('the wallet returned no account');

      setStep('requesting a single-use nonce');
      const nr = await fetch('/v1/auth/nonce', { headers: { accept: 'application/json' } });
      if (!nr.ok) throw new Error(`the nonce endpoint answered ${nr.status}`);
      const { nonce } = (await nr.json()) as { nonce: string };
      if (!nonce) throw new Error('the nonce endpoint answered without a nonce');

      const message = createSiweMessage({
        address: address as `0x${string}`,
        chainId: CHAIN_ID,
        domain: SIWE_DOMAIN,
        nonce,
        uri: SIWE_URI,
        version: '1',
        issuedAt: new Date(),
        statement: 'Sign in to ARCANA. This signature proves you hold this wallet. It authorises no transaction and moves no funds.',
      });

      setStep('waiting for you to sign in your wallet');
      const signature = (await eth.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string;

      setStep('presenting the signature');
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (!r.ok) {
        // The service's own sentence. "Sign-in failed" would throw away the
        // only part that tells anyone what to do next.
        throw new Error(body?.error || `sign-in was refused (${r.status})`);
      }

      setStep('signed in');
      router.replace(next);
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A wallet rejection is not an error to apologise for; it is the person
      // saying no, and it should read that way.
      setError(/user rejected|denied|4001/i.test(msg) ? 'You declined the signature in your wallet. Nothing was sent.' : msg);
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  if (host === null) {
    return (
      <div className="m3" style={{ fontSize: 12.5 }}>
        checking what this page can do…
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 620 }}>
      {!domainMatches ? (
        <div className="callout callout-bad">
          <strong>This deployment cannot complete a sign-in yet, and will not fake one.</strong>
          <div style={{ marginTop: 8 }}>
            A sign-in message names the site asking for it, and the server matches that name exactly. This page is
            being served from <span className="mono">{host}</span>, and the configured sign-in domain is{' '}
            <span className="mono">{SIWE_DOMAIN || '(not set)'}</span>.
          </div>
          <div style={{ marginTop: 8 }}>
            Signing anyway would put a domain you are not visiting into the text your wallet shows you — which is the
            exact thing that field exists to let you catch. The fix is configuration, not a click:{' '}
            <span className="mono">AUTH_SIWE_DOMAIN</span> and <span className="mono">AUTH_SIWE_URI</span> on the
            agent service must name the origin this site is actually served from. This page reads the same values at
            request time, so there is nothing to rebuild once they are set.
          </div>
        </div>
      ) : null}

      {hasWallet === false ? (
        <div className="callout callout-warn">
          <strong>No wallet is available in this browser.</strong> ARCANA signs in with a wallet and nothing else —
          there is no password to fall back to. Install a browser wallet, or open this page in one.
        </div>
      ) : null}

      <div>
        <button
          className="btn btn-primary"
          style={{ padding: '10px 20px', fontSize: 15 }}
          onClick={signIn}
          disabled={busy || !domainMatches || hasWallet === false}
          aria-disabled={busy || !domainMatches || hasWallet === false ? 'true' : undefined}
        >
          {busy ? 'Signing in…' : 'Sign in with your wallet'}
        </button>
      </div>

      {step ? (
        <div className="mono m2" style={{ fontSize: 11.5 }}>
          {step}…
        </div>
      ) : null}

      {error ? (
        <div className="callout callout-bad">
          <strong>Sign-in did not complete.</strong>
          <div className="mono" style={{ marginTop: 6, fontSize: 11.5, wordBreak: 'break-word' }}>
            {error}
          </div>
        </div>
      ) : null}

      <div className="m3" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        ARCANA never asks for a private key. Your wallet signs a message locally; only the message and its signature
        are sent. The session token is stored in a cookie the page itself cannot read.
      </div>
    </div>
  );
}
