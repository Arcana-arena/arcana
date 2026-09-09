import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AUTH_CONFIG, readAuthContext, writeAuthContext } from './auth-context';
import type { AuthConfig } from './config';
import {
  authUnavailable,
  forbiddenInternal,
  forbiddenNotAdmin,
  unauthenticated,
} from './errors';
import { InvalidTokenError, verifyAccessToken } from './tokens';

/**
 * 🔑 tier — requires a valid access token, nothing more.
 *
 * Order of refusals matters and is deliberate:
 *   no signing key  -> 503, because we cannot check, and saying 401 here would
 *                      blame the caller for our own misconfiguration.
 *   no/!bearer      -> 401
 *   bad token       -> 401
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();

    if (!this.cfg.signingKey) {
      throw authUnavailable(
        this.cfg.signingKeyProblem ?? 'no signing key is configured',
      );
    }

    const header: string | undefined = req.headers?.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthenticated(
        'This endpoint requires a signed-in wallet. Send an access token as ' +
          '`Authorization: Bearer <token>` (obtain one via POST /v1/auth/verify).',
      );
    }

    try {
      const claims = verifyAccessToken(this.cfg, header.slice('Bearer '.length).trim());
      writeAuthContext(req, { wallet: claims.sub, sessionId: claims.sid });
    } catch (e) {
      if (e instanceof InvalidTokenError) {
        throw unauthenticated(`Access token rejected: ${e.message}.`);
      }
      // Anything else is us failing, not the caller presenting a bad token.
      throw authUnavailable(`access token could not be checked: ${String(e)}`);
    }

    return true;
  }
}

/**
 * 👑 tier — an operator wallet. Compose AFTER JwtAuthGuard:
 *   @UseGuards(JwtAuthGuard, AdminGuard)
 *
 * An empty allowlist denies everyone rather than allowing everyone. A gate that
 * opens when unconfigured is not a gate.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const auth = readAuthContext(ctx.switchToHttp().getRequest());
    if (!auth) {
      throw authUnavailable(
        'AdminGuard ran without an authenticated context — JwtAuthGuard must precede it',
      );
    }
    if (!this.cfg.adminWallets.includes(auth.wallet.toLowerCase())) {
      throw forbiddenNotAdmin(
        'This is an operator action. The signed-in wallet is not in AUTH_ADMIN_WALLETS.',
      );
    }
    return true;
  }
}

/**
 * ⚙️ tier — machine-to-machine. The scheduler and batch jobs cannot sign in
 * with a wallet, so they present a shared secret instead.
 *
 * This is the second of two layers; the first is that every service binds to
 * 127.0.0.1. Either alone would be thin — a leaked key with services bound to
 * 0.0.0.0 is full access, and localhost-only with no key trusts every process
 * on the box.
 *
 * An unconfigured key yields 503, never a pass. That does mean a missing
 * INTERNAL_API_KEY stops the scheduler — which is the correct failure: a tick
 * that opens because a secret was missing is worse than a tick that does not
 * open and says why.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();

    if (!this.cfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so machine-tier calls cannot be verified',
      );
    }

    const provided: string | undefined =
      req.headers?.['x-internal-key'] ?? req.headers?.['X-Internal-Key'];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw forbiddenInternal(
        'This endpoint is machine-only and requires the X-Internal-Key header.',
      );
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(this.cfg.internalKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw forbiddenInternal('X-Internal-Key does not match.');
    }

    return true;
  }
}
