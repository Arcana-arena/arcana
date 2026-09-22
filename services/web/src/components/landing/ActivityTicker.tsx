'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Feed, RecentDecision, RecentExecution } from '@/lib/platform';

/**
 * What the platform has just done, as one running strip.
 *
 * NO EVENT TABLE, AND THERE IS NOT GOING TO BE ONE. Every line here is derived
 * from `/v1/decisions/recent` and `/v1/executions/recent`, which already exist
 * and which the landing page already reads. An events table would be a second
 * record of things the decisions and executions tables have recorded properly
 * for months, and the first time the two disagreed the newer one would win for
 * no reason other than being newer.
 *
 * IT POLLS THE API DIRECTLY, from the browser, because nginx already proxies
 * `/v1/` on this origin. No Next route was added to stand in the middle: a
 * passthrough that only forwards a GET is a second thing to keep in step with
 * the endpoint it forwards.
 *
 * THE HARD PART IS THE EMPTY STATE, and it is the reason this file is longer
 * than the animation it drives. These endpoints return the most recent N rows
 * WHATEVER THEIR AGE — ask on a quiet Sunday and you get last Thursday's
 * trades, with nothing in the response saying they are stale. A ticker is a
 * claim about NOW. So the newest row's age is checked against STALE_AFTER_MS,
 * and past it the strip stops presenting itself as live and says how long it
 * has actually been quiet. Scrolling old rows under a pulsing dot would be the
 * exact lie this site is built to avoid: an absence dressed as activity.
 */

/** How old the newest line may be before the strip stops calling itself live. */
const STALE_AFTER_MS = 15 * 60 * 1000;
/** How often to ask. Short enough to feel live, long enough not to be rude. */
const POLL_MS = 15_000;
const LIMIT = 12;

type Line = {
  key: string;
  ts: string;
  agentId: string;
  agentName: string;
  /** The verb, already decided — the component does no interpreting below. */
  text: string;
  detail: string | null;
  tone: 'settled' | 'refused' | 'decided';
};

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * An execution becomes a line. A REFUSAL BECOMES ONE TOO, and deliberately:
 * a strip that showed only what went through would describe a platform that
 * never refuses anything, which is the opposite of what this one sells.
 */
function fromExecution(e: RecentExecution): Line | null {
  if (!e.action || e.action === 'approve') return null; // an approval is plumbing
  const verb = e.action.toUpperCase();
  const sym = e.symbol ?? '';
  if (e.status === 'mined') {
    return {
      key: `x:${e.tx_hash ?? `${e.agent_id}:${e.ts}`}`,
      ts: e.ts,
      agentId: e.agent_id,
      agentName: e.agent_name,
      text: `executed ${verb}${sym ? ` ${sym}` : ''}`,
      detail: e.notional_usdg !== null ? `${e.notional_usdg.toFixed(2)} USDG` : null,
      tone: 'settled',
    };
  }
  return {
    key: `x:${e.agent_id}:${e.ts}`,
    ts: e.ts,
    agentId: e.agent_id,
    agentName: e.agent_name,
    // "blocked" is a refusal the platform made on purpose; "reverted" is the
    // chain refusing. Both are named rather than merged into "failed".
    text: `${e.status === 'blocked' ? 'was refused' : 'reverted'} ${verb}${sym ? ` ${sym}` : ''}`,
    detail: e.refusal_code,
    tone: 'refused',
  };
}

/**
 * A decision becomes a line only when it is a trade intent.
 *
 * HOLDS ARE LEFT OUT, and this is the one editorial choice in the file. Most
 * decisions are holds — by design, since an agent that does not see a move
 * beyond its band does nothing — and a strip of "held, held, held" would bury
 * the two lines a reader came for. They are not hidden: /agents and every
 * agent's own page list every decision including holds, and the strip's own
 * footer says where.
 */
function fromDecision(d: RecentDecision): Line | null {
  if (!d.action || d.action === 'hold') return null;
  if (d.tx_hash) return null; // it settled; the execution feed says it better
  return {
    key: `d:${d.agent_id}:${d.ts}`,
    ts: d.ts,
    agentId: d.agent_id,
    agentName: d.agent_name,
    text: `decided ${d.action.toUpperCase()}${d.symbol ? ` ${d.symbol}` : ''}`,
    detail: d.execution_status === null ? 'not settled yet' : d.execution_status,
    tone: 'decided',
  };
}

export function ActivityTicker() {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const load = async () => {
      try {
        const [dR, xR] = await Promise.all([
          fetch(`/v1/decisions/recent?limit=${LIMIT}`, { cache: 'no-store' }),
          fetch(`/v1/executions/recent?limit=${LIMIT}`, { cache: 'no-store' }),
        ]);
        if (!dR.ok || !xR.ok) throw new Error(`the service answered ${dR.status}/${xR.status}`);
        const d: Feed<RecentDecision> = await dR.json();
        const x: Feed<RecentExecution> = await xR.json();

        // MERGED AND SORTED ONCE, newest first, with a key that dedupes a
        // decision against the execution it produced.
        const merged = [
          ...x.items.map(fromExecution),
          ...d.items.map(fromDecision),
        ].filter((l): l is Line => l !== null)
          .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

        const seen = new Set<string>();
        const unique = merged.filter((l) => (seen.has(l.key) ? false : (seen.add(l.key), true)));

        if (!mounted.current) return;
        setLines(unique.slice(0, LIMIT));
        setFailed(null);
        setNow(Date.now());
      } catch (e) {
        if (!mounted.current) return;
        // A FAILED READ IS NOT AN EMPTY PLATFORM. The strip says which it is.
        setFailed(e instanceof Error ? e.message : String(e));
      }
    };

    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => mounted.current && setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const newestAge = useMemo(() => {
    if (!lines || lines.length === 0) return null;
    return now - new Date(lines[0].ts).getTime();
  }, [lines, now]);

  const live = newestAge !== null && newestAge < STALE_AFTER_MS;

  return (
    <div className="px-ticker" aria-label="Recent platform activity">
      <div className="px-ticker-head">
        <span className={live ? 'px-ticker-dot pulse' : 'px-ticker-dot px-ticker-dot-idle'} aria-hidden="true" />
        <span className="px-ticker-label">{live ? 'LIVE' : 'ACTIVITY'}</span>
      </div>

      <div className="px-ticker-rail">
        {failed !== null ? (
          <span className="px-ticker-quiet">
            Activity could not be read — {failed}. This is the feed failing, not the platform being idle.
          </span>
        ) : lines === null ? (
          <span className="px-ticker-quiet">Reading the record…</span>
        ) : lines.length === 0 ? (
          <span className="px-ticker-quiet">
            No trade in the most recent {LIMIT} decisions. Agents hold when nothing moves past their rebalance band —{' '}
            <Link href="/agents">every decision, including holds</Link>.
          </span>
        ) : !live ? (
          <span className="px-ticker-quiet">
            No activity in the last {Math.round(STALE_AFTER_MS / 60000)} minutes. The most recent was{' '}
            {ago(newestAge as number)} — <Link href="/agents">the full record</Link>.
          </span>
        ) : (
          // Duplicated once so the marquee can loop without a gap. The copy is
          // aria-hidden: a screen reader should hear each line once.
          <div className="px-ticker-track">
            {[0, 1].map((copy) => (
              <div className="px-ticker-run" key={copy} aria-hidden={copy === 1 ? 'true' : undefined}>
                {lines.map((l) => (
                  <span className={`px-ticker-item px-ticker-${l.tone}`} key={`${copy}:${l.key}`}>
                    <Link href={`/agents/${l.agentId}`} className="px-ticker-agent">
                      {l.agentName}
                    </Link>{' '}
                    {l.text}
                    {l.detail ? <span className="px-ticker-detail"> · {l.detail}</span> : null}
                    <span className="px-ticker-age"> · {ago(now - new Date(l.ts).getTime())}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
