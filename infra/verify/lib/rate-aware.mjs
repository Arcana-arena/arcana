/**
 * Rate-limit-aware HTTP and sign-in, shared by every verification suite.
 *
 * WHY THIS EXISTS, AND WHY IT IS ONE MODULE RATHER THAN A HABIT
 *
 * Phase 12 put real limits on the auth surface — 20/min on nonce, 10/min on
 * verify, 30/min on refresh — and the verification suites are the heaviest
 * clients those endpoints have. Between them they sign in more than thirty
 * times per run, from one IP, deliberately including every invalid attempt.
 *
 * That produced the same bug four times, and it was patched in a different
 * place each time:
 *
 *   1. auth-verify failed under the limit          -> waited once
 *   2. once was not enough                         -> made it a loop
 *   3. agents-verify computed its expected budget  -> read it from the server
 *   4. auth-verify and agents-verify ran back to   -> ???
 *      back and fought over the same window
 *
 * The fourth one is where patching stops working. Each suite's waiting logic
 * was written assuming IT was the only thing using the window, and two suites
 * in sequence break that assumption no matter how carefully either one is
 * written. agents-verify's signIn() called /v1/auth/verify through a plain
 * request with no 429 handling at all, so after auth-verify drained the verify
 * budget it could not sign in, threw during setup, and died before printing a
 * summary — reported as "? pass ? fail", which reads like a crash rather than
 * a queue.
 *
 * So there is one implementation and every suite imports it. A suite that
 * needs an unprotected request still has `req`; what it no longer has is its
 * own private idea of how to wait.
 *
 * WHAT WAS NOT DONE, AND WHY
 *
 * Exempting loopback from the limiter would have made all of this disappear in
 * one line. It is the wrong line. Put a reverse proxy in front of these
 * services later — which the frontend work will — and every request arrives
 * from 127.0.0.1, silently disabling rate limiting platform-wide on the day it
 * matters most. A slow test is a much smaller problem than a limiter that
 * quietly stops applying.
 *
 * The suites live inside the same constraint a real client does, and back off
 * using the Retry-After the server already sends.
 */
import { createSiweMessage } from 'viem/siwe';

/**
 * THE ORIGIN ARCANA ACCEPTS SIGN-INS FOR — read here and nowhere else.
 *
 * `arcana.local` used to be a literal in eight suites and two systemd units.
 * That is not a duplicated constant, it is a duplicated DECISION: the day the
 * domain changed, every place that was missed would have kept signing for a
 * site that no longer exists, and the failure would have surfaced somewhere
 * with nothing to do with domains.
 *
 * It throws rather than falling back. A default here would let a run that
 * forgot to source .env.siwe sign for the wrong domain and then report eleven
 * unrelated failures — which is exactly how the last orphan-engine bug wasted
 * an afternoon. Refusing to start says the one useful sentence instead.
 */
function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is not set. Sign-in messages name the origin they are for and the ` +
      'server matches it exactly, so a verification run has to be told which one. ' +
      'Source it first:  set -a; . ./.env.siwe; set +a',
    );
  }
  return v.trim();
}

export const SIWE_DOMAIN = required('AUTH_SIWE_DOMAIN');
export const SIWE_URI = required('AUTH_SIWE_URI');
export const SIWE_CHAIN_ID = Number(process.env.AUTH_SIWE_CHAIN_ID || 4663);

export const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

/**
 * A plain request. No retry, no waiting.
 *
 * Kept exported because a suite that TESTS rate limiting must be able to get a
 * 429 back. agents-verify's flood section uses this deliberately; nothing else
 * should.
 */
/**
 * EVERY REQUEST A SUITE MAKES CARRIES THE VERIFICATION MARKER.
 *
 * Added here rather than at each call site, because a marker somebody has to
 * remember is a marker somebody forgets. The decision engine reads it and
 * refuses to act on any agent that holds a wallet — so a suite pointed at a
 * funded agent fails its check instead of spending money.
 *
 * It can only ever cost the caller permissions. There is no request this makes
 * succeed that would otherwise fail, so adding it unconditionally is safe even
 * for the suites that never go near the chain.
 *
 * The rule this enforces was bought: on 2026-09-11 a suite drove the cadence
 * past a floor that had been deliberately removed, opened a real tick, and
 * bought $5.96 of MSFT. See services/decision-engine/internal/engine/verification.go.
 */
export const VERIFICATION_HEADER = { 'X-Arcana-Verification': '1' };

export async function req(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...VERIFICATION_HEADER, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/**
 * How many times to wait before giving up.
 *
 * Bounded on purpose. If three cleared windows are not enough, something other
 * than this suite is consuming the allowance, and waiting quietly forever
 * would turn a real problem into a hung test that looks like a slow one.
 */
const MAX_WAITS = 3;

/**
 * A request that waits out a 429 instead of failing under it.
 *
 * Returns the final response either way — including the 429, if the budget
 * never cleared — so a caller sees the real status rather than a fabricated
 * one. Silence about having waited would make a two-minute suite look like a
 * fast one that got lucky.
 */
export async function reqRL(url, opts = {}, label = '') {
  for (let attempt = 0; attempt <= MAX_WAITS; attempt++) {
    const r = await req(url, opts);
    if (r.status !== 429) return r;
    if (attempt === MAX_WAITS) {
      console.error(
        `  still rate limited on ${label || url} after ${MAX_WAITS} waits — ` +
          'something other than this suite is consuming the allowance',
      );
      return r;
    }
    const wait = Math.min(70, Number(r.headers?.get?.('retry-after') ?? 60) + 2);
    console.log(`  (allowance spent on ${label || url.split('/').pop()}; waiting ${wait}s)`);
    await sleep(wait);
  }
}

/**
 * Guarantee `need` requests of headroom before a DELIBERATE burst.
 *
 * For the case reqRL cannot serve: a check that fires several requests at once
 * to observe a race. Waiting between them would destroy the race, and a burst
 * where most responses are 429 proves nothing — "exactly one succeeded" is
 * meaningless if the others never reached the thing being raced for.
 *
 * Reads X-RateLimit-Remaining, which these endpoints already return, rather
 * than guessing from a count the caller keeps.
 */
export async function ensureHeadroom(url, need) {
  const probe = await req(url, { method: 'HEAD' }).catch(() => null);
  const remaining = Number(probe?.headers?.get?.('x-ratelimit-remaining') ?? NaN);
  if (Number.isFinite(remaining) && remaining >= need) return;
  console.log(`  (draining the window before a burst of ${need})`);
  await sleep(62);
}

/** Fetch a nonce, waiting out the limit. */
export async function getNonce(agentUrl) {
  const r = await reqRL(`${agentUrl}/v1/auth/nonce`, {}, 'auth/nonce');
  return r.body?.nonce;
}

/**
 * Sign in with SIWE, waiting out the limit on both endpoints it touches.
 *
 * `overrides` exists for the suites that sign in WRONGLY on purpose — a bad
 * chain id, a stale nonce, a signature from the wrong key. Those must still go
 * through the same waiting path: a deliberately-invalid attempt consumes
 * exactly as much allowance as a valid one, which is the detail that made the
 * per-suite versions undercount.
 *
 * Returns the whole response, not just a token, so a caller can assert on the
 * refusal.
 */
export async function signIn(agentUrl, account, opts = {}) {
  const {
    chainId = SIWE_CHAIN_ID,
    domain = SIWE_DOMAIN,
    uri = SIWE_URI,
    statement = 'Sign in to ARCANA.',
    nonce: givenNonce,
    signature: givenSignature,
    issuedAt,
  } = opts;

  const nonce = givenNonce ?? (await getNonce(agentUrl));
  const message = createSiweMessage({
    address: account.address,
    chainId,
    domain,
    nonce,
    uri,
    version: '1',
    issuedAt: issuedAt ?? new Date(),
    statement,
  });
  const signature = givenSignature ?? (await account.signMessage({ message }));
  const r = await reqRL(
    `${agentUrl}/v1/auth/verify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    },
    'auth/verify',
  );
  return { ...r, message, signature, nonce };
}

/** Convenience for the common case: sign in and return the access token. */
export async function signInToken(agentUrl, account, opts = {}) {
  const r = await signIn(agentUrl, account, opts);
  return r.body?.access_token;
}

export const bearer = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * NestJS answers 201 to a POST unless the handler says otherwise.
 *
 * Asserting 200 has bitten this project twice, so the intent — "it worked" —
 * is written down once instead of guessed at each call site.
 */
export const ok2xx = (status) => status >= 200 && status < 300;
