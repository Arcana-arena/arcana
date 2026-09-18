/**
 * The only place this app talks to the backend.
 *
 * THE RULE THIS FILE ENFORCES: a read either returns data, or says it failed.
 * It never returns an empty object that renders like data. Every caller gets a
 * discriminated union and has to handle the failure branch, because the whole
 * point of this surface is that a reader can tell "nothing happened" from
 * "we could not find out".
 *
 * It also does no arithmetic. Not one number on this site is computed here —
 * ranks, scores, counts, percentages and downsampled series all arrive already
 * decided by the service that owns the definition. A second implementation in
 * the browser would agree on every day it still agreed.
 */

const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);

export type Ok<T> = { ok: true; data: T };
/**
 * A failed read, with the reason a person can act on AND the code a page can
 * branch on.
 *
 * `code` was missing entirely, which is how the reason came to be wrong too:
 * with nowhere to put the envelope's `code`, the failure branch reached past
 * `message` and stringified the whole `error` object. `null` is honest here —
 * a timeout and a non-JSON body genuinely have no code.
 */
export type Err = { ok: false; status: number | null; reason: string; code: string | null };
export type Result<T> = Ok<T> | Err;

export const AGENT_API = process.env.AGENT_API || 'http://127.0.0.1:3001';
export const MARKETPLACE_API = process.env.MARKETPLACE_API || 'http://127.0.0.1:3002';
// 3004, where arca-service listens (3003 is taken on the host). The unit sets
// ARCA_API; the default must not name a port nothing listens on.
export const ARCA_API = process.env.ARCA_API || 'http://127.0.0.1:3004';
export const MARKET_API = process.env.MARKET_API || 'http://127.0.0.1:8083';

/**
 * WHY `cache: 'no-store'` IS NOT NEGOTIABLE HERE. Next will happily serve a
 * page built minutes ago. A leaderboard that is quietly stale still looks
 * authoritative — it has ranks and a timestamp and everything — which makes it
 * worse than a page that failed to load. Every response carries its own
 * as-of stamp from the backend and the page prints it.
 */
async function read<T>(base: string, path: string): Promise<Result<T>> {
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
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
        code: null,
      };
    }
    if (!r.ok) {
      // THE ENVELOPE IS UNWRAPPED, NOT STRINGIFIED.
      //
      // Every ARCANA service answers `{error:{code,message,trace_id}}`, which
      // has no top-level `message`. The old branch fell through to `?.error`,
      // found the OBJECT, and `String()` turned it into `[object Object]` —
      // rendered by <Failed> at forty-eight call sites as "The service answered
      // 401: [object Object]". That is a page telling a reader nothing while
      // looking like it told them something, on the exact surface this file
      // exists to keep honest: `auth_unavailable` and `forbidden_not_owner` are
      // "we could not find out" and "no", and both arrived as the same nothing.
      //
      // A plain Nest exception (`{message, error:'Not Found', statusCode}`)
      // still works: its `error` is a string, so it is not treated as an
      // envelope and its top-level message is used. This is the same unwrap
      // session.ts has always done on the write path — the two now agree.
      const inner = (body as { error?: unknown } | null)?.error;
      const detail = (inner && typeof inner === 'object' ? inner : body) as Record<string, unknown> | null;
      const msg = detail?.message ?? r.statusText;
      return {
        ok: false,
        status: r.status,
        reason: Array.isArray(msg) ? msg.join('; ') : String(msg || `status ${r.status}`),
        code: typeof detail?.code === 'string' ? detail.code : null,
      };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      status: null,
      reason: aborted
        ? `the service did not answer within ${TIMEOUT_MS}ms`
        : `the service could not be reached (${e instanceof Error ? e.message : String(e)})`,
      // No answer means no code. Inventing one here would let a page branch on
      // a refusal that was never made.
      code: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const agent = <T>(path: string) => read<T>(AGENT_API, path);
export const marketplace = <T>(path: string) => read<T>(MARKETPLACE_API, path);
export const arca = <T>(path: string) => read<T>(ARCA_API, path);
/** market-data. The universe an agent may trade comes from here, never from a copy. */
export const market = <T>(path: string) => read<T>(MARKET_API, path);

/** Build a query string, dropping only genuinely absent values — not falsy ones. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}
