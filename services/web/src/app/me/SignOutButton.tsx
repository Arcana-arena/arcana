'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sign out, and say what actually happened.
 *
 * The session cookies are cleared by the route regardless of whether the server
 * accepted the revocation, because a browser still holding a session after
 * somebody pressed this is the worse of the two failures. But if the refresh
 * token could NOT be revoked server-side it stays valid until it expires, and
 * that is worth one sentence rather than a silent success.
 */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch('/api/session', { method: 'DELETE' });
      const body = (await r.json().catch(() => null)) as
        | { refresh_token_revoked?: boolean | null; reason?: string | null }
        | null;
      if (body && body.refresh_token_revoked === false) {
        setNote(
          'Signed out in this browser. The server did not confirm the token was revoked' +
            (body.reason ? ` (${body.reason})` : '') +
            ', so it stays valid until it expires.',
        );
        setBusy(false);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch (e) {
      setNote(`Sign-out request failed: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn" onClick={signOut} disabled={busy} aria-disabled={busy ? 'true' : undefined}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {note ? (
        <div className="callout callout-warn" style={{ marginTop: 10, maxWidth: 520 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}
