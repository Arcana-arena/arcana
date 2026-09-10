import { HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * The §8 error envelope: { error: { code, message, trace_id } }.
 *
 * Every auth refusal goes through here so the five outcomes below stay
 * distinguishable to a caller. They are five different facts and collapsing any
 * two of them produces a response that reads like a lie:
 *
 *   401 unauthenticated            you have not signed in
 *   403 forbidden_not_owner        you signed in, but this is not yours
 *   403 forbidden_not_admin        you signed in, but this is an operator action
 *   403 forbidden_legacy_readonly  nobody owns this; it predates auth
 *   403 forbidden_internal         machine-only endpoint, wrong or absent key
 *   503 auth_unavailable           we could not check. Neither allowed nor denied.
 *
 * The last one is the one worth guarding. Answering 401 when the signing key is
 * missing would tell a signed-in user "you are not logged in" when the truth is
 * "we are broken" — the same class of clean-looking lie that the marketplace's
 * hasAccess and the entitlement 502 were fixed to stop telling.
 */
export function authErrorBody(code: string, message: string) {
  return { error: { code, message, trace_id: randomUUID() } };
}

export function unauthenticated(message: string): HttpException {
  return new HttpException(
    authErrorBody('unauthenticated', message),
    HttpStatus.UNAUTHORIZED,
  );
}

export function forbidden(code: string, message: string): HttpException {
  return new HttpException(authErrorBody(code, message), HttpStatus.FORBIDDEN);
}

export function forbiddenNotOwner(message: string): HttpException {
  return forbidden('forbidden_not_owner', message);
}

export function forbiddenNotAdmin(message: string): HttpException {
  return forbidden('forbidden_not_admin', message);
}

export function forbiddenLegacyReadonly(message: string): HttpException {
  return forbidden('forbidden_legacy_readonly', message);
}

export function forbiddenInternal(message: string): HttpException {
  return forbidden('forbidden_internal', message);
}

/**
 * 503, and deliberately not 401 or 403.
 *
 * Raised when the service cannot perform the check at all — no signing key, no
 * internal key, session storage unreadable. The message says so out loud so the
 * caller is never left to infer a permission problem from an outage.
 */
export function authUnavailable(reason: string): HttpException {
  return new HttpException(
    authErrorBody(
      'auth_unavailable',
      `Authentication cannot be verified: ${reason}. ` +
        'The request was neither allowed nor denied.',
    ),
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/**
 * "This resource is addressed by wallet, and it must be yours."
 *
 * Used where a path or query names a wallet — subscriptions, accounts, access
 * checks. Before auth these endpoints would answer for any address handed to
 * them, which made one user's payment history readable by anyone who knew their
 * address. The comparison is case-insensitive because EIP-55 checksumming
 * changes the case but not the identity.
 */
export function assertSameWallet(
  sessionWallet: string,
  claimedWallet: string,
  subject: string,
): void {
  if (sessionWallet.toLowerCase() !== claimedWallet.toLowerCase()) {
    throw forbiddenNotOwner(
      `${subject} belongs to another wallet. A session can only read its own.`,
    );
  }
}

/**
 * 429 — too many requests, and specifically NOT a judgement about the caller.
 *
 * Distinct from every 401/403 above, which say something about identity. This
 * says nothing about who is asking: the same caller, one second later, is
 * welcome. Collapsing it into 403 would tell a legitimate user their
 * credentials were rejected, which sends them to re-authenticate — more
 * requests, on the endpoint that is already saturated.
 *
 * The message states the limit and the wait, because a client that knows both
 * can back off correctly, and one that is guessing will poll.
 */
export function rateLimited(
  limit: number,
  windowSeconds: number,
  retryAfterSeconds: number,
): HttpException {
  return new HttpException(
    authErrorBody(
      'rate_limited',
      `Too many requests: this endpoint allows ${limit} per ${windowSeconds}s. ` +
        `Try again in ${retryAfterSeconds}s. This is not a rejection of your ` +
        'credentials — the same request will succeed once the window clears.',
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
