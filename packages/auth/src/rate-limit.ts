import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { rateLimited } from './errors';
import { readAuthContext } from './auth-context';

/**
 * Rate limiting.
 *
 * The system had none. Anywhere. The most exposed hole was
 * `GET /v1/auth/nonce`, which is unauthenticated by necessity — it is how a
 * caller becomes authenticated — and **writes a row to the database on every
 * call**. A loop over that endpoint fills the nonce table as fast as the
 * network allows, from a machine that has never proved it is anybody, and the
 * first symptom is the disk.
 *
 * WHY IN-PROCESS, AND WHAT THAT COSTS
 *
 * A shared counter (Redis, or a Postgres row) would be exact across services
 * and would survive a restart. Both properties are real, and neither is worth
 * what they cost here: another daemon on a 2 GB host, or a database write on
 * the path whose database writes are the thing being limited. Rate limiting
 * that writes to the database to decide whether to let you write to the
 * database has given back most of what it was for.
 *
 * So the counters live in the process, and the two consequences are stated
 * rather than glossed:
 *
 *   1. Each service counts separately. A caller hitting agent-service and
 *      marketplace gets each service's allowance, not one shared budget. For
 *      per-endpoint limits, which is all this is, that is correct anyway — the
 *      limits protect each endpoint's own cost.
 *
 *   2. A restart forgets everything. An attacker who can make the service
 *      restart has a much better attack available than resetting a counter.
 *
 * WHAT IT IS NOT. This is not DDoS protection and does not pretend to be: it
 * sees only requests that already reached Node, so it cannot help with volume
 * that saturates the link. It stops one client from cheaply doing expensive
 * things — which is the shape of the actual exposure here.
 */

interface Bucket {
  /** Timestamps, ms. Oldest first; older-than-window entries are dropped. */
  hits: number[];
}

const RATE_LIMIT_KEY = 'arcana:rate-limit';

export interface RateLimitSpec {
  /** How many requests are allowed in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Count per authenticated wallet when there is one, falling back to IP.
   * Off by default: a limit whose key a caller chooses is not a limit, and for
   * unauthenticated endpoints there is no wallet to key on anyway.
   */
  byWallet?: boolean;
}

/**
 * Declare a limit on one route.
 *
 * Deliberately per-route rather than global. A global limit has to be set for
 * the most expensive endpoint and is then far too tight for reading a
 * leaderboard, or set for the cheapest and protects nothing. The endpoints
 * that need protecting are the ones that write, and they are few enough to
 * name.
 *
 * ORDERING MATTERS, AND IT READS BACKWARDS. Decorators apply bottom-up, and
 * Nest runs guards in the order they were registered, so the guard written
 * LOWEST runs FIRST. For `byWallet` to see a wallet, JwtAuthGuard must have
 * run already, which means:
 *
 *     @Post()
 *     @RateLimit({ ..., byWallet: true })   // higher
 *     @UseGuards(JwtAuthGuard)              // lower, so it runs first
 *
 * Getting it the other way round does not silently fall back to counting by
 * IP — see canActivate(). A limit that quietly changes what it counts is a
 * limit nobody can reason about.
 */
export const RateLimit = (spec: RateLimitSpec) =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, spec), UseGuards(RateLimitGuard));

@Injectable()
export class RateLimitGuard implements CanActivate {
  /**
   * One map per process. Keyed by "route|client".
   *
   * Bounded by a sweep, because an unbounded map keyed on client IP is itself
   * a memory exhaustion bug — the exact class of problem this guard exists to
   * prevent, reintroduced by the guard. Ironic and entirely possible.
   */
  private static buckets = new Map<string, Bucket>();
  private static lastSweep = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const spec = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(
      RATE_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!spec) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();

    let who: string;
    if (spec.byWallet) {
      const auth = readAuthContext(req);
      if (!auth) {
        // LOUD, not a fallback. Reaching here means this guard ran before
        // JwtAuthGuard — the decorators are in the wrong order — and counting
        // by IP instead would be a limit silently measuring something other
        // than what it says. The endpoint would still work, the counter would
        // still count, and the property nobody could rely on is the one the
        // limit was written for.
        throw new Error(
          `@RateLimit({ byWallet: true }) on ${ctx.getClass().name}.${ctx.getHandler().name} ` +
            'ran before any authentication guard, so there is no wallet to count against. ' +
            'Put @RateLimit ABOVE @UseGuards(JwtAuthGuard): decorators apply bottom-up, so ' +
            'the guard written lowest runs first.',
        );
      }
      who = `w:${auth.wallet}`;
    } else {
      who = `i:${clientIp(req)}`;
    }
    const key = `${req.method} ${ctx.getClass().name}.${ctx.getHandler().name}|${who}`;

    const now = Date.now();
    const windowMs = spec.windowSeconds * 1000;
    RateLimitGuard.sweep(now);

    let bucket = RateLimitGuard.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      RateLimitGuard.buckets.set(key, bucket);
    }

    // A sliding window, not a fixed one. A fixed window lets a caller send the
    // full allowance in the last instant of one window and again in the first
    // instant of the next — twice the limit, back to back, entirely legally.
    const cutoff = now - windowMs;
    while (bucket.hits.length > 0 && bucket.hits[0] <= cutoff) bucket.hits.shift();

    if (bucket.hits.length >= spec.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000));
      // Standard headers, so a well-behaved client can back off on its own
      // rather than hammering until it is banned.
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(spec.limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      throw rateLimited(spec.limit, spec.windowSeconds, retryAfter);
    }

    bucket.hits.push(now);
    res.setHeader('X-RateLimit-Limit', String(spec.limit));
    res.setHeader('X-RateLimit-Remaining', String(spec.limit - bucket.hits.length));
    return true;
  }

  /**
   * Drop buckets nobody has touched for an hour.
   *
   * Runs at most once a minute, inline, rather than on a timer: a timer keeps
   * the event loop alive and has to be torn down in tests and on shutdown, and
   * this needs neither precision nor punctuality.
   */
  private static sweep(now: number): void {
    if (now - RateLimitGuard.lastSweep < 60_000) return;
    RateLimitGuard.lastSweep = now;
    const dead = now - 3_600_000;
    for (const [k, b] of RateLimitGuard.buckets) {
      if (b.hits.length === 0 || b.hits[b.hits.length - 1] < dead) {
        RateLimitGuard.buckets.delete(k);
      }
    }
  }

  /** Test seam. Not exported through index.ts. */
  static resetForTests(): void {
    RateLimitGuard.buckets.clear();
    RateLimitGuard.lastSweep = 0;
  }
}

/**
 * The caller's address.
 *
 * `X-Forwarded-For` is honoured ONLY when the app is behind a proxy it was
 * told about (`trust proxy`), which Express reflects in `req.ip`. Reading the
 * header directly would let any caller set their own rate-limit key and make
 * the limit meaningless — the single most common way a rate limiter is built
 * wrong.
 */
function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
