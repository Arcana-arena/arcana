import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AUTH_CONFIG,
  authUnavailable,
  signAccessToken,
  unauthenticated,
  type AuthConfig,
} from '@arcana/auth';
import { SiweVerifier } from './siwe.verifier';

export interface SessionTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  wallet_address: string;
}

/**
 * Sign-in, session rotation and revocation.
 *
 * Deliberately uses raw SQL rather than repositories: every one of these
 * operations is an atomic state transition whose correctness lives in the WHERE
 * clause, and an ORM round-trip would hide exactly the part that matters.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    private readonly siwe: SiweVerifier,
  ) {}

  /**
   * Is this wallet an operator?
   *
   * The same list AdminGuard reads, asked as a question rather than enforced as
   * a gate, so `/v1/auth/me` can tell a caller about itself and the web can
   * render moderation controls to somebody who can use them. It answers only
   * about the wallet that asked; the list itself is never published.
   */
  isOperator(wallet: string): boolean {
    return this.cfg.adminWallets.includes(wallet.toLowerCase());
  }

  private assertSignInPossible(): void {
    if (!this.cfg.signingKey) {
      throw authUnavailable(this.cfg.signingKeyProblem ?? 'no signing key configured');
    }
    if (!this.cfg.siweDomain || !this.cfg.siweUri) {
      throw authUnavailable('AUTH_SIWE_DOMAIN/AUTH_SIWE_URI are not configured');
    }
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Issue a single-use nonce.
   *
   * Unbound to any wallet, because at this point there is no wallet — the
   * client has not signed anything yet. Binding happens implicitly: the nonce
   * appears inside the signed message, so a signature ties the two together.
   */
  async issueNonce(): Promise<{ nonce: string; expires_at: string }> {
    this.assertSignInPossible();

    // Hex, so it matches the [A-Za-z0-9] alphabet EIP-4361 requires.
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + this.cfg.nonceTtlSeconds * 1000);

    await this.db.query(
      `INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, $2)`,
      [nonce, expiresAt],
    );

    // Opportunistic sweep; keeps the table from growing without a timer.
    await this.db
      .query(`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'`)
      .catch((e: unknown) =>
        this.logger.warn(`could not sweep expired nonces: ${String(e)}`),
      );

    return { nonce, expires_at: expiresAt.toISOString() };
  }

  /**
   * Verify a SIWE message + signature and open a session.
   *
   * The ordering here is the security property, not an implementation detail:
   *
   *   1. validate every message field (domain, uri, chainId, issuedAt)
   *   2. CONSUME THE NONCE ATOMICALLY
   *   3. only then recover the signature
   *
   * Step 2 is a single `UPDATE ... WHERE used_at IS NULL ... RETURNING`. Read
   * that as one statement, because that is what makes replay impossible: two
   * identical requests arriving together both reach the UPDATE, and exactly one
   * of them gets a row back. A `SELECT` followed by an `UPDATE` would let both
   * pass the SELECT and both proceed — a replay defeated only by luck.
   *
   * Consuming before recovery also means a burnt nonce on a bad signature. That
   * is intended: it stops a live nonce being used as an oracle to grind
   * signatures against.
   */
  async verifySignIn(message: string, signature: string): Promise<SessionTokens> {
    this.assertSignInPossible();

    const fields = this.siwe.parseAndValidate(this.cfg, message);

    // The UPDATE is wrapped in a CTE so the statement is a top-level SELECT.
    //
    // This is not cosmetic. TypeORM's `query()` returns a plain row array for a
    // SELECT, but a `[rows, affectedCount]` TUPLE for a bare
    // `UPDATE ... RETURNING`. Its `.length` is therefore always 2, so a
    // "did anything match?" test written as `.length === 0` is never true and
    // the gate silently admits everyone. The first version of this code had
    // exactly that shape, and the nonce was replayable — found only because the
    // verification suite replays one and demands a refusal. Selecting over the
    // CTE gives one unambiguous shape while the UPDATE stays a single atomic
    // statement.
    const consumed: Array<{ nonce: string }> = await this.db.query(
      `WITH consumed AS (
         UPDATE auth_nonces
            SET used_at = now()
          WHERE nonce = $1
            AND used_at IS NULL
            AND expires_at > now()
        RETURNING nonce
       )
       SELECT nonce FROM consumed`,
      [fields.nonce],
    );
    if (consumed.length === 0) {
      throw unauthenticated(
        'Sign-in nonce is unknown, already used, or expired. Request a new one ' +
          'from GET /v1/auth/nonce and sign a fresh message.',
      );
    }

    const verified = await this.siwe.recoverSigner(message, signature, fields.address);

    const tokens = await this.openSession(verified.wallet);
    this.logger.log(`sign-in ok for ${verified.wallet} (session ${tokens.wallet_address})`);
    return tokens;
  }

  /** Create a brand-new session family for a wallet. */
  private async openSession(wallet: string): Promise<SessionTokens> {
    const familyId = randomUUID();
    return this.mintTokens(wallet, familyId);
  }

  /**
   * Mint one access token plus one refresh token, recording only the refresh
   * token's SHA-256 hash. A dump of auth_sessions yields nothing usable.
   */
  private async mintTokens(wallet: string, familyId: string): Promise<SessionTokens> {
    const refreshToken = randomBytes(32).toString('hex');
    const refreshHash = AuthService.hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + this.cfg.refreshTtlSeconds * 1000);

    await this.db.query(
      `INSERT INTO auth_sessions
         (wallet_address, family_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [wallet, familyId, refreshHash, refreshExpiresAt],
    );

    const access = signAccessToken(this.cfg, { wallet, sessionId: familyId });

    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTtlSeconds,
      refresh_token: refreshToken,
      refresh_expires_in: this.cfg.refreshTtlSeconds,
      wallet_address: wallet,
    };
  }

  /**
   * Rotate a refresh token.
   *
   * A refresh token is valid exactly once. Presenting one that has already been
   * used is not a retry — the legitimate holder rotated it away, so a second
   * presentation means a copy exists somewhere it should not. The response to
   * that is to revoke the ENTIRE family, logging both the thief and the victim
   * out, because we cannot tell which of the two is asking.
   */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    this.assertSignInPossible();

    const hash = AuthService.hashToken(refreshToken);
    const rows: Array<{
      id: string;
      wallet_address: string;
      family_id: string;
      used_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date;
    }> = await this.db.query(
      `SELECT id, wallet_address, family_id, used_at, revoked_at, expires_at
         FROM auth_sessions WHERE refresh_token_hash = $1`,
      [hash],
    );

    if (rows.length === 0) {
      throw unauthenticated('Refresh token is not recognised.');
    }
    const row = rows[0];

    if (row.revoked_at) {
      throw unauthenticated('This session has been revoked. Sign in again.');
    }
    if (row.used_at) {
      await this.revokeFamily(row.family_id, 'refresh_reuse_detected');
      this.logger.error(
        `refresh token REUSE for wallet ${row.wallet_address} (family ` +
          `${row.family_id}) — the whole family has been revoked`,
      );
      throw unauthenticated(
        'This refresh token was already used. For safety every session from ' +
          'that sign-in has been revoked — sign in again.',
      );
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw unauthenticated('Refresh token has expired. Sign in again.');
    }

    // Same shape as the nonce consume, for the same reason: two concurrent
    // rotations must not both succeed.
    const claimed: Array<{ id: string }> = await this.db.query(
      `WITH claimed AS (
         UPDATE auth_sessions SET used_at = now()
          WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id
       )
       SELECT id FROM claimed`,
      [row.id],
    );
    if (claimed.length === 0) {
      await this.revokeFamily(row.family_id, 'refresh_race_detected');
      throw unauthenticated(
        'This refresh token was used concurrently. Every session from that ' +
          'sign-in has been revoked — sign in again.',
      );
    }

    return this.mintTokens(row.wallet_address, row.family_id);
  }

  /** Revoke one session family — the refresh chain from a single sign-in. */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const revoked: Array<{ id: string }> = await this.db.query(
      `WITH revoked AS (
         UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = $2
          WHERE family_id = $1 AND revoked_at IS NULL
        RETURNING id
       )
       SELECT id FROM revoked`,
      [familyId, reason],
    );
    return revoked.length;
  }

  /**
   * Log out.
   *
   * Revokes the refresh family so no new access token can be minted. The access
   * token already in the caller's hand stays valid until it expires — at most
   * AUTH_ACCESS_TTL_SECONDS (15 minutes by default). That window is a conscious
   * trade: the alternative is a revocation lookup on every single request,
   * which puts a cache on the critical path of the whole API and turns its
   * outage into an unanswerable question. Documented in docs/auth.md.
   */
  async logout(refreshToken: string): Promise<{ revoked: number }> {
    const hash = AuthService.hashToken(refreshToken);
    const rows: Array<{ family_id: string }> = await this.db.query(
      `SELECT family_id FROM auth_sessions WHERE refresh_token_hash = $1`,
      [hash],
    );
    if (rows.length === 0) {
      // Not an error: logging out an unknown token is the state the caller
      // wanted. Saying "unrecognised" would leak which tokens exist.
      return { revoked: 0 };
    }
    return { revoked: await this.revokeFamily(rows[0].family_id, 'logout') };
  }

  /** Revoke every session for a wallet, across all sign-ins. */
  async revokeAllForWallet(wallet: string): Promise<{ revoked: number }> {
    const revoked: Array<{ id: string }> = await this.db.query(
      `WITH revoked AS (
         UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'logout_all'
          WHERE wallet_address = $1 AND revoked_at IS NULL
        RETURNING id
       )
       SELECT id FROM revoked`,
      [wallet.toLowerCase()],
    );
    return { revoked: revoked.length };
  }
}
