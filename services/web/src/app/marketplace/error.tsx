'use client';

import Link from 'next/link';

/**
 * The marketplace threw while rendering.
 *
 * IT SAYS THE PAGE FAILED. It does not fall back to an empty grid, which would
 * read as "no agent is for sale" — a claim about the marketplace made by a bug
 * in the page. The digest is printed because it is the one string that connects
 * this screen to a line in the server log.
 */
export default function MarketplaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
      <div className="status status-bad">
        <div className="status-title">The marketplace page failed to render</div>
        <div className="status-body">
          Nothing is shown below rather than an empty grid, because an empty grid would mean there is nothing for sale
          and that is not what happened.
          <div className="mono m3" style={{ marginTop: 10, fontSize: 11, wordBreak: 'break-word' }}>
            {error.message}
            {error.digest ? ` · digest ${error.digest}` : ''}
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={reset}>
              Try again
            </button>
            <Link href="/leaderboard" className="btn">
              Leaderboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
