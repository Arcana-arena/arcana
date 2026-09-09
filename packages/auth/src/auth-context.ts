import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** What a verified access token puts on the request. */
export interface AuthContext {
  /** Lowercased wallet address proven by SIWE. */
  wallet: string;
  /** auth_sessions.family_id of the sign-in this token belongs to. */
  sessionId: string;
}

/** Injection token for the process-wide AuthConfig. */
export const AUTH_CONFIG = 'ARCANA_AUTH_CONFIG';

/**
 * The request property guards write and handlers read.
 *
 * Named distinctly from anything a client can send: the whole point of this
 * work is that identity comes from a verified token and never from the request
 * body, so it must be impossible for a payload field to land here.
 */
export const AUTH_REQUEST_KEY = 'arcanaAuth';

export function readAuthContext(req: unknown): AuthContext | undefined {
  return (req as Record<string, AuthContext | undefined>)[AUTH_REQUEST_KEY];
}

export function writeAuthContext(req: unknown, ctx: AuthContext): void {
  (req as Record<string, AuthContext>)[AUTH_REQUEST_KEY] = ctx;
}

/**
 * `@CurrentWallet()` — the signed-in wallet, guaranteed present because a
 * guard rejected the request otherwise.
 */
export const CurrentWallet = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest();
    const auth = readAuthContext(req);
    if (!auth) {
      // Reaching here means a handler asked for the wallet without a guard in
      // front of it. Failing loudly is the only safe answer: returning
      // undefined would let the handler treat an anonymous caller as someone.
      throw new Error(
        '@CurrentWallet() used on a route with no JwtAuthGuard — refusing to ' +
          'return an unverified identity',
      );
    }
    return auth.wallet;
  },
);

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest();
    const auth = readAuthContext(req);
    if (!auth) {
      throw new Error('@CurrentSession() used on a route with no JwtAuthGuard');
    }
    return auth;
  },
);
