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
export type Err = { ok: false; status: number | null; reason: string };
export type Result<T> = Ok<T> | Err;

export const AGENT_API = process.env.AGENT_API || 'http://127.0.0.1:3001';
export const MARKETPLACE_API = process.env.MARKETPLACE_API || 'http://127.0.0.1:3002';
export const ARCA_API = process.env.ARCA_API || 'http://127.0.0.1:3003';
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
      return { ok: false, status: r.status, reason: `the service answered ${r.status} with something that is not JSON` };
    }
    if (!r.ok) {
      const msg =
        (body as { message?: unknown } | null)?.message ??
        (body as { error?: unknown } | null)?.error ??
        r.statusText;
      return {
        ok: false,
        status: r.status,
        reason: Array.isArray(msg) ? msg.join('; ') : String(msg || `status ${r.status}`),
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
