import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from './config';

/**
 * HS256 access tokens, implemented directly on node:crypto.
 *
 * Written out rather than pulled from a library so the three ways JWT
 * verification is normally broken are visible and closed here:
 *
 *   1. `alg: none`      — the header algorithm is never trusted to select the
 *                          verifier. HS256 is hardcoded and any other value is
 *                          rejected before a signature is computed.
 *   2. algorithm confusion — same reason. There is one algorithm and one key;
 *                          an attacker cannot talk us into a different pair.
 *   3. non-constant-time comparison — timingSafeEqual, on equal-length buffers.
 *
 * Access tokens are deliberately NOT stored anywhere. Revocation is handled on
 * the refresh side (auth_sessions); a live access token stays valid for the
 * remainder of its TTL. That window is real and documented in docs/auth.md
 * rather than papered over.
 */

export interface AccessTokenClaims {
  /** Wallet address, lowercased. The verified identity. */
  sub: string;
  /** auth_sessions.family_id — ties this token to a sign-in. */
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export class InvalidTokenError extends Error {}

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(key: string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signAccessToken(
  cfg: AuthConfig,
  params: { wallet: string; sessionId: string },
): { token: string; expiresAt: Date; jti: string } {
  if (!cfg.signingKey) {
    // Callers must check tokensActive first; reaching here is a programming
    // error, not a user-facing condition.
    throw new Error('signAccessToken called with no signing key configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + cfg.accessTtlSeconds;
  const jti = randomUUID();

  const claims: AccessTokenClaims = {
    sub: params.wallet.toLowerCase(),
    sid: params.sessionId,
    jti,
    iat: now,
    exp,
    iss: cfg.issuer,
    aud: cfg.audience,
  };

  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signature = b64urlEncode(hmac(cfg.signingKey, `${header}.${payload}`));

  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date(exp * 1000),
    jti,
  };
}

export function verifyAccessToken(cfg: AuthConfig, token: string): AccessTokenClaims {
  if (!cfg.signingKey) {
    throw new Error('verifyAccessToken called with no signing key configured');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new InvalidTokenError('token is not a three-part JWT');
  }
  const [header, payload, signature] = parts;

  // Parse the header only to REJECT it. Nothing in it selects a code path.
  let parsedHeader: { alg?: unknown; typ?: unknown };
  try {
    parsedHeader = JSON.parse(b64urlDecode(header).toString('utf8'));
  } catch {
    throw new InvalidTokenError('token header is not valid JSON');
  }
  if (parsedHeader.alg !== 'HS256') {
    throw new InvalidTokenError(`unsupported token algorithm: ${String(parsedHeader.alg)}`);
  }
  if (parsedHeader.typ !== 'JWT') {
    throw new InvalidTokenError('token type is not JWT');
  }

  const expected = hmac(cfg.signingKey, `${header}.${payload}`);
  const provided = b64urlDecode(signature);
  // timingSafeEqual throws on a length mismatch, which is itself a signal — but
  // an attacker already knows the digest length, so checking it first leaks
  // nothing and keeps the comparison total.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidTokenError('token signature does not verify');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    throw new InvalidTokenError('token payload is not valid JSON');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new InvalidTokenError('token has expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) {
    throw new InvalidTokenError('token was issued in the future');
  }
  if (claims.iss !== cfg.issuer) {
    throw new InvalidTokenError('token issuer does not match');
  }
  if (claims.aud !== cfg.audience) {
    throw new InvalidTokenError('token audience does not match');
  }
  if (typeof claims.sub !== 'string' || !/^0x[0-9a-f]{40}$/.test(claims.sub)) {
    throw new InvalidTokenError('token subject is not a wallet address');
  }
  if (typeof claims.sid !== 'string' || claims.sid.length === 0) {
    throw new InvalidTokenError('token carries no session id');
  }

  return claims;
}
