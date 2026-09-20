import { cookies } from 'next/headers';
import { AGENT_API } from './api';

/**
 * The signed-in session, held where the browser cannot read it.
 *
 * WHY httpOnly COOKIES AND NOT localStorage. The access token is a bearer
 * secret: anything that can read it can act as the wallet until it expires. In
 * localStorage it is readable by every script on the origin, which means one
 * injected dependency is a full account takeover. In an httpOnly cookie it is
 * readable by nobody in the page — the server attaches it, and the pages here
 * render on the server anyway, so the browser never needs it.
 *
 * The cookie is SameSite=Lax so it does not ride along on cross-site requests,
 * and Secure whenever the deployment is not plain loopback http.
 *
 * WHY THE REFRESH TOKEN IS IN A SEPARATE COOKIE with a narrower path: it is the
 * longer-lived secret and the only one that can mint new access tokens. Nothing
 * but the session route ever needs to send it, so nothing else is given it.
 *
 * NOTHING HERE INVENTS A SESSION. Every function returns null rather than a
 * guess, and `requireSession` hands the caller a reason it can print.
 */

const ACCESS = 'arcana_at';
const REFRESH = 'arcana_rt';

export type Session = {
  wallet_address: string;
  /** null is a normal state: signing in does not create a creator profile. */
  creator_id: string | null;
  /**
   * Whether this wallet is in AUTH_ADMIN_WALLETS.
   *
   * Used only to decide which controls are worth rendering. IT IS NOT A
   * PERMISSION: every operator route checks AdminGuard on the server, and a
   * button that is merely absent has never stopped anyone. Optional because a
   * service deployed before this field existed simply omits it, and `false` is
   * the right reading of "did not say".
   */
  is_operator?: boolean;
};

export type SessionState =
  | { state: 'signed_in'; session: Session; token: string }
  | { state: 'signed_out' }
  /** A session exists but the service could not confirm it. NOT signed out. */
  | { state: 'unknown'; reason: string };

const secure = (process.env.PUBLIC_ORIGIN ?? '').startsWith('https://');

export async function setSessionCookies(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}) {
  const jar = await cookies();
  jar.set(ACCESS, tokens.access_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: tokens.expires_in,
  });
  jar.set(REFRESH, tokens.refresh_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/session',
    maxAge: tokens.refresh_expires_in,
  });
}

export async function clearSessionCookies() {
  const jar = await cookies();
  jar.set(ACCESS, '', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 });
  jar.set(REFRESH, '', { httpOnly: true, sameSite: 'lax', secure, path: '/api/session', maxAge: 0 });
}

export async function accessToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCESS)?.value || null;
}

export async function refreshToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(REFRESH)?.value || null;
}

/**
 * Who is signed in, asked of the service rather than decoded from the token.
 *
 * THE THREE ANSWERS ARE KEPT APART. "Signed out" means there is no token or the
 * service rejected it. "Unknown" means there IS a token and the service could
 * not be reached to say — and a page must not render that as signed out, because
 * telling someone they are logged out when the truth is that a backend is down
 * invites them to sign in again and again against nothing.
 */
export async function getSession(): Promise<SessionState> {
  const token = await accessToken();
  if (!token) return { state: 'signed_out' };

  try {
    const r = await fetch(`${AGENT_API}/v1/auth/me`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) return { state: 'signed_out' };
    if (!r.ok) {
      return { state: 'unknown', reason: `the service answered ${r.status} when asked who you are` };
    }
    const body = (await r.json()) as Session;
    if (!body?.wallet_address) {
      return { state: 'unknown', reason: 'the service answered without a wallet address' };
    }
    return { state: 'signed_in', session: body, token };
  } catch (e) {
    return {
      state: 'unknown',
      reason: `the service could not be reached (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * A read or a write made as the signed-in wallet. Mirrors lib/api.ts, with the
 * bearer — and with the service's own error body kept intact.
 *
 * `body` IS RETURNED ON FAILURE, not just the message. The payment failures are
 * the reason: `insufficient_amount` carries the shortfall, `no_matching_transfer`
 * carries where the money actually went, and `tx_already_claimed` carries what
 * it bought. Flattening those into one sentence would leave the three screens
 * that exist to tell a buyer exactly what went wrong with nothing to tell them.
 */
export async function authed<T>(
  path: string,
  init?: { method?: string; body?: unknown; base?: string },
): Promise<
  | { ok: true; data: T }
  | { ok: false; status: number | null; reason: string; body: Record<string, unknown> | null; code: string | null }
> {
  const token = await accessToken();
  if (!token) {
    return {
      ok: false, status: 401, reason: 'no session cookie was sent with this request', body: null, code: null,
    };
  }
  try {
    const r = await fetch(`${init?.base ?? AGENT_API}${path}`, {
      cache: 'no-store',
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        status: r.status,
        reason: `the service answered ${r.status} with something that is not JSON`,
        body: null,
        code: null,
      };
    }
    if (!r.ok) {
      const inner = (body as { error?: Record<string, unknown> } | null)?.error;
      const detail = (inner && typeof inner === 'object' ? inner : body) as Record<string, unknown> | null;
      const msg = detail?.message ?? r.statusText;
      return {
        ok: false,
        status: r.status,
        reason: Array.isArray(msg) ? msg.join('; ') : String(msg || r.status),
        body: detail,
        // THE SAME FIELD THE READ PATH NOW CARRIES. This wrapper always
        // unwrapped the envelope correctly and handed back `body`, so every
        // caller that wanted the code had to dig it out — three files grew
        // their own four-line `codeOf` helper doing exactly that. Lifting it
        // here is what lets one <Failed> render a code whichever wrapper
        // produced the failure; `body` stays, because the four claim screens
        // read far more than the code from it.
        code: typeof detail?.code === 'string' ? detail.code : null,
      };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return {
      ok: false, status: null, reason: e instanceof Error ? e.message : String(e), body: null, code: null,
    };
  }
}
