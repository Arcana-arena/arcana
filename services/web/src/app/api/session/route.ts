import { NextRequest, NextResponse } from 'next/server';
import { AGENT_API } from '@/lib/api';
import { clearSessionCookies, refreshToken, setSessionCookies } from '@/lib/session';

/**
 * The only route in this app that writes.
 *
 * It exists so the tokens never touch the page. The browser signs the SIWE
 * message — that is the one thing only the wallet can do — and posts the
 * message and signature here. This route calls the auth service, receives the
 * token pair, and puts it in httpOnly cookies. Nothing readable by a script on
 * the origin ever holds a bearer secret.
 *
 * IT ALSO REFUSES TO INVENT A SESSION. If the service rejects the signature, the
 * status and the service's own sentence go back to the caller unchanged — a
 * sign-in that failed for "nonce already used" and one that failed for "domain
 * does not match" need different things from the person reading it, and
 * flattening both into "sign-in failed" hides the only useful part.
 */

export const dynamic = 'force-dynamic';

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
};

export async function POST(req: NextRequest) {
  let payload: { message?: unknown; signature?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'the request body is not JSON' }, { status: 400 });
  }
  if (typeof payload.message !== 'string' || typeof payload.signature !== 'string') {
    return NextResponse.json(
      { error: 'both `message` and `signature` are required, as strings' },
      { status: 400 },
    );
  }

  let r: Response;
  try {
    r = await fetch(`${AGENT_API}/v1/auth/verify`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ message: payload.message, signature: payload.signature }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `the auth service could not be reached: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json(
      { error: `the auth service answered ${r.status} with something that is not JSON` },
      { status: 502 },
    );
  }

  if (!r.ok) {
    // THE SERVICE'S OWN WORDS, NOT A SUMMARY OF THEM.
    const err = body as { error?: { code?: string; message?: string }; message?: string } | null;
    return NextResponse.json(
      {
        error: err?.error?.message ?? err?.message ?? `sign-in was refused (${r.status})`,
        code: err?.error?.code ?? null,
      },
      { status: r.status },
    );
  }

  const tokens = body as Tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    return NextResponse.json({ error: 'the auth service answered without a token pair' }, { status: 502 });
  }
  await setSessionCookies(tokens);
  return NextResponse.json({ ok: true });
}

/**
 * Sign out.
 *
 * The cookies are cleared EVEN IF the service call fails, and the response says
 * which happened. A browser that still holds a session cookie after the person
 * pressed sign out is the worse failure of the two: the local session is what
 * they can see, and leaving it in place while reporting success would be a lie
 * they would only discover by still being signed in.
 */
export async function DELETE() {
  const rt = await refreshToken();
  let revoked: boolean | null = null;
  let reason: string | null = null;

  if (rt) {
    try {
      const r = await fetch(`${AGENT_API}/v1/auth/logout`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      revoked = r.ok;
      if (!r.ok) reason = `the auth service answered ${r.status}`;
    } catch (e) {
      revoked = false;
      reason = e instanceof Error ? e.message : String(e);
    }
  }

  await clearSessionCookies();
  return NextResponse.json({
    ok: true,
    session_cookies_cleared: true,
    // Stated rather than assumed: if the refresh token was not revoked server
    // side it remains valid until it expires, and that is worth knowing.
    refresh_token_revoked: revoked,
    reason,
  });
}
