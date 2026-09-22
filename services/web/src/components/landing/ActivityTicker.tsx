'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Feed, RecentDecision, RecentExecution } from '@/lib/platform';

/**
 * The landing page's ticker, now live.
 *
 * IT REPLACES THE STATIC ONE RATHER THAN SITTING BESIDE IT. A strip of the
 * latest decisions already existed here, server-rendered once per page load
 * and never updated. A second ticker was built next to it by mistake and the
 * two shared class names, so the new CSS restyled the old element — which is
 * how the duplication was noticed. There is one ticker again; this is it.
 *
 * NO EVENT TABLE. Every line comes from `/v1/decisions/recent` and
 * `/v1/executions/recent`, which already existed. An events table would be a
 * second record of what those two have held correctly for months, and the
 * first time they disagreed the newer one would win for no reason but being
 * newer. It polls `/v1/` straight from the browser, since nginx already
 * proxies it on this origin.
 *
 * IT RENDERS BEFORE IT POLLS. `initial` is the decision feed the page already
 * fetched on the server, so the strip has content in the first paint and for
 * anyone without JavaScript. The poll then widens it to executions and keeps
 * it current.
 *
 * THE HARD PART IS THE EMPTY STATE. These endpoints return the most recent N
 * rows WHATEVER THEIR AGE — ask on a quiet Sunday and you get Thursday's
 * trades, with nothing in the response saying they are stale. A ticker is a
 * claim about NOW, so the newest row's age is checked, and past STALE_AFTER_MS
 * the strip stops calling itself live and says how long it has been quiet.
 * Four outcomes are kept apart that a lazier strip would merge into one blank
 * bar: the read failed, nothing has been recorded at all, nothing has happened
 * recently, and all is well.
 */

/** How old the newest line may be before the strip stops calling itself live. */
const STALE_AFTER_MS = 15 * 60 * 1000;
/** How often to ask. Short enough to feel live, long enough not to be rude. */
const POLL_MS = 15_000;
/** One of the values the endpoint accepts — it validates against a whitelist,
 *  and an arbitrary number is a 400 the page then has to explain. */
const LIMIT = '15';

type Line = {
  key: string;
  ts: string;
  agentId: string;
  agentName: string;
  action: string;
  symbol: string | null;
  verb: string;
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
 * An execution becomes a line. A REFUSAL BECOMES ONE TOO, deliberately: a
 * strip showing only what went through would describe a platform that never
 * refuses anything, which is the opposite of what this one sells.
 */
function fromExecution(e: RecentExecution): Line | null {
  if (!e.action || e.action === 'approve') return null; // an approval is plumbing
  const common = {
    ts: e.ts,
    agentId: e.agent_id,
    agentName: e.agent_name,
    action: e.action,
    symbol: e.symbol,
  };
  if (e.status === 'mined') {
    return {
      ...common,
      key: `x:${e.tx_hash ?? `${e.agent_id}:${e.ts}`}`,
      verb: 'executed',
      detail: e.notional_usdg !== null ? `${e.notional_usdg.toFixed(2)} USDG` : null,
      tone: 'settled',
    };
  }
  return {
    ...common,
    key: `x:${e.agent_id}:${e.ts}`,
    // "blocked" is a refusal ARCANA made on purpose; "reverted" is the chain
    // refusing. Both are named rather than merged into "failed".
    verb: e.status === 'blocked' ? 'refused' : 'reverted',
    detail: e.refusal_code,
    tone: 'refused',
  };
}

/**
 * A decision becomes a line only when it is a trade intent that has not
 * settled — the execution feed describes the settled ones better.
 *
 * HOLDS ARE LEFT OUT, and it is the one editorial choice here. Most decisions
 * are holds by design, since an agent that sees no move beyond its band does
 * nothing, and a strip reading "held, held, held" buries the two lines a
 * reader came for. They are not hidden: the table directly under this strip
 * lists every decision including holds.
 */
function fromDecision(d: RecentDecision): Line | null {
  if (!d.action || d.action === 'hold') return null;
  if (d.tx_hash) return null;
  return {
    key: `d:${d.agent_id}:${d.ts}`,
    ts: d.ts,
    agentId: d.agent_id,
    agentName: d.agent_name,
    action: d.action,
    symbol: d.symbol,
    verb: 'decided',
    detail: d.execution_status ?? 'not settled yet',
    tone: 'decided',
  };
}

const merge = (xs: RecentExecution[], ds: RecentDecision[]): Line[] => {
  const all = [...xs.map(fromExecution), ...ds.map(fromDecision)]
    .filter((l): l is Line => l !== null)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const seen = new Set<string>();
  return all.filter((l) => (seen.has(l.key) ? false : (seen.add(l.key), true))).slice(0, Number(LIMIT));
};

export function ActivityTicker({ initial }: { initial: RecentDecision[] }) {
  const [lines, setLines] = useState<Line[]>(() => merge([], initial));
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
        if (!mounted.current) return;
        setLines(merge(x.items, d.items));
        setFailed(null);
        setNow(Date.now());
      } catch (e) {
        if (!mounted.current) return;
        // A FAILED READ IS NOT AN EMPTY PLATFORM, and the strip says which.
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

  const newestAge = useMemo(
    () => (lines.length === 0 ? null : now - new Date(lines[0].ts).getTime()),
    [lines, now],
  );
  const live = failed === null && newestAge !== null && newestAge < STALE_AFTER_MS;

  /**
   * A MESSAGE REPLACES THE LINES ONLY WHEN THERE ARE NO LINES.
   *
   * The first version hid perfectly good activity behind "nothing in the last
   * fifteen minutes" whenever the newest row was older than that — and on a
   * platform whose agents hold until the market moves past their rebalance
   * band, that is most of the time. A strip that is almost always empty while
   * the data sits right there is not honesty, it is just useless.
   *
   * So age is told rather than hidden: every line carries its own "15h ago",
   * the dot goes grey and the word LIVE goes away. The reader sees what
   * happened and exactly how long ago, which is more honest than a sentence
   * that withholds it.
   */
  const note =
    failed !== null
      ? `Activity could not be read — ${failed}. That is the feed failing, not the platform being idle.`
      : lines.length === 0
        ? 'No trade among the most recent decisions. Agents hold when nothing moves past their rebalance band; every decision is in the table below.'
        : null;

  return (
    <div className="px-ticker" aria-label="Recent platform activity">
      <div className="px-ticker-live">
        <span
          className="px-ticker-status"
          title={
            live
              ? 'Something happened in the last few minutes.'
              : newestAge !== null
                ? `Quiet: the most recent activity was ${ago(newestAge)}. Each line below carries its own age.`
                : undefined
          }
        >
          <span className={live ? 'px-ticker-dot pulse' : 'px-ticker-dot px-ticker-dot-idle'} aria-hidden="true" />
          {live ? 'LIVE' : 'QUIET'}
        </span>

        {note !== null ? (
          <span className="px-ticker-quiet">{note}</span>
        ) : (
          <div className="px-ticker-track">
            {/* Two copies make a seamless loop; the second is hidden from
                assistive technology so each line is announced once. */}
            {[0, 1].map((copy) => (
              <div className="px-ticker-run" key={copy} aria-hidden={copy === 1 ? true : undefined}>
                {lines.map((l) => (
                  <span className={`px-ticker-item px-ticker-${l.tone}`} key={`${copy}:${l.key}`}>
                    <Link href={`/agents/${l.agentId}`} className="px-ticker-name">
                      {l.agentName}
                    </Link>
                    <span>{l.verb}</span>
                    <span className="mono">
                      {l.action.toUpperCase()}
                      {l.symbol ? ` ${l.symbol}` : ''}
                    </span>
                    {l.detail ? <span className="px-ticker-detail">{l.detail}</span> : null}
                    <span className="px-ticker-age">{ago(now - new Date(l.ts).getTime())}</span>
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
