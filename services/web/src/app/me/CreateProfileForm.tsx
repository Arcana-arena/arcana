'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createProfile } from './actions';

/**
 * The door into the product, which was not there.
 *
 * A wallet that signs in with no creator profile could read the whole platform
 * and do nothing on it: an agent belongs to a creator, and the only way to make
 * one was `POST /v1/creators` with a handle. The page said so honestly and was
 * still a dead end — the mockups all assume a creator already exists, which is
 * true of nobody arriving today.
 *
 * THE WALLET IS NOT A FIELD. The service takes it from the verified session and
 * refuses to read one from the body, because a profile claiming an address it
 * has not proved would be trusted by every per-wallet check downstream. So this
 * form asks for one thing.
 *
 * THE HANDLE RULE IS ENFORCED IN THE FORM AS WELL AS THE SERVICE, and shown
 * while typing. The service refuses anything outside `[a-z0-9_]`, and finding
 * that out from a 400 after choosing a name is a worse way to learn it. The
 * service is still the authority: this only spares the round trip.
 *
 * IT IS PERMANENT-ISH AND THE FORM SAYS SO. A handle can be renamed later
 * (`PATCH /v1/creators/:id`), but one wallet gets one profile — the service
 * refuses a second — so this is not a choice to make twice.
 */

const HANDLE = /^[a-z0-9_]+$/;

export function CreateProfileForm({ wallet }: { wallet: string }) {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ status: number | null; reason: string; code: string | null } | null>(null);

  const trimmed = handle.trim();
  const tooLong = trimmed.length > 50;
  const badChars = trimmed.length > 0 && !HANDLE.test(trimmed);
  const ok = trimmed.length > 0 && !tooLong && !badChars;

  return (
    <section className="box" style={{ maxWidth: 560 }}>
      <div className="k">Create your creator profile</div>
      <p className="m2" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 8 }}>
        An agent belongs to a creator, so this comes first. It is one name, and it is public: it appears beside every
        agent you run, on the leaderboard and in the marketplace.
      </p>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="handle">Handle</label>
        <input
          id="handle"
          className="input mono"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="kestrel"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{ width: '100%' }}
        />
        <div className="help">
          Lowercase letters, digits and underscores, up to 50 characters.{' '}
          {badChars ? (
            <span className="dn">
              &ldquo;{trimmed}&rdquo; would be refused — remove anything outside a&ndash;z, 0&ndash;9 and _.
            </span>
          ) : tooLong ? (
            <span className="dn">That is {trimmed.length} characters; the limit is 50.</span>
          ) : ok ? (
            <span className="up">Your agents will be shown as {trimmed}/&lt;agent&gt;.</span>
          ) : null}
        </div>
      </div>

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Bound to</dt>
        <dd className="mono brk">{wallet}</dd>
      </dl>
      <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
        Taken from the wallet you signed in with, not from this form. A profile that could name an address it had
        not proved would be trusted by every per-wallet check on the platform.
      </div>

      {/* NOT A PAYEE YET, and saying so here saves a listing that cannot be
          bought. The creator wallet a buyer pays is a separate field the
          platform cannot set for you — it is where money goes. */}
      <div className="callout callout-note" style={{ marginTop: 14 }}>
        <strong>This does not make you payable.</strong> Selling a subscription needs a wallet address on the profile
        for buyers to pay directly; until there is one, a listing of yours would refuse every quote. Creating agents,
        competing and being ranked need nothing more than this.
      </div>

      <button
        className="btn btn-primary"
        style={{ marginTop: 14, opacity: ok ? 1 : 0.45 }}
        disabled={!ok || pending}
        onClick={() =>
          start(async () => {
            setFail(null);
            const r = await createProfile(trimmed);
            if (r.ok) router.refresh();
            else setFail(r);
          })
        }
      >
        {pending ? 'Creating…' : `Create ${trimmed || 'profile'}`}
      </button>

      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 12 }}>
          <strong>
            {fail.status === 409
              ? 'This wallet already has a profile'
              : (fail.code ?? `The service answered ${fail.status ?? 'nothing'}`)}
          </strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </section>
  );
}
