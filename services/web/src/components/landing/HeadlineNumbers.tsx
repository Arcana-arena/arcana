import { int, money } from '@/lib/format';
import type { PlatformStats } from '@/lib/platform';

/**
 * The three numbers a first-time visitor should see before scrolling.
 *
 * EVERY ONE IS THE DATABASE'S. `usdg_24h` and `settled_24h` are aggregates the
 * stats query computes with a FILTER on the rows it was already summing; this
 * component adds nothing up and subtracts nothing. The alternative — a page
 * holding yesterday's total and today's and differencing them — is arithmetic
 * in a browser over two reads taken at different moments, which is how a
 * landing page ends up confidently reporting a negative day.
 *
 * "SETTLED SWAPS ONLY" SURVIVED THE PROMOTION, and that is the point of
 * enlarging these rather than writing new ones. The small strip already
 * carried that label; a big number that dropped it would read as total
 * activity and quietly include the blocked and reverted orders — exactly the
 * flattering version this platform exists to refuse.
 *
 * AN OLDER BACKEND RENDERS A DASH, NOT A ZERO. The two 24-hour fields are
 * optional on the type because a service deployed before they existed omits
 * them, and `0 USDG settled today` would be a confident lie about a quiet day
 * that may have been busy.
 */
export function HeadlineNumbers({ stats }: { stats: PlatformStats }) {
  const has24h = typeof stats.volume.usdg_24h === 'number';
  const hasSettled24h = typeof stats.executions.settled_24h === 'number';

  return (
    <div className="px-headline" aria-label="Today on ARCANA">
      <div className="px-headline-item">
        <div className="px-headline-value">
          {has24h ? money(stats.volume.usdg_24h as number) : <span className="px-headline-absent">—</span>}
          <span className="px-headline-unit"> USDG</span>
        </div>
        <div className="px-headline-label">
          settled on-chain today
          <span className="px-headline-note"> · settled swaps only</span>
        </div>
      </div>

      <div className="px-headline-sep" aria-hidden="true" />

      <div className="px-headline-item">
        <div className="px-headline-value">
          {hasSettled24h ? int(stats.executions.settled_24h as number) : <span className="px-headline-absent">—</span>}
        </div>
        <div className="px-headline-label">
          trades executed today
          <span className="px-headline-note"> · {int(stats.executions.settled)} all time</span>
        </div>
      </div>

      <div className="px-headline-sep" aria-hidden="true" />

      <div className="px-headline-item">
        <div className="px-headline-value">{int(stats.decisions.last_24h)}</div>
        <div className="px-headline-label">
          decisions in 24h
          <span className="px-headline-note"> · holds included</span>
        </div>
      </div>
    </div>
  );
}
