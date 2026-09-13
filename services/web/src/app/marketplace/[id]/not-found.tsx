import Link from 'next/link';

/**
 * A listing id that names nothing.
 *
 * The distinction the copy has to make: this is not a listing that exists and
 * is empty, and it is not a listing that is switched off — a switched-off
 * listing still renders, marked, because its record is worth reading. This is
 * an address with no listing behind it at all.
 */
export default function ListingNotFound() {
  return (
    <div style={{ padding: '64px 32px', maxWidth: 680, margin: '0 auto' }}>
      <div className="status">
        <div className="status-title">No listing at this address</div>
        <div className="status-body">
          The marketplace holds no listing with this id. That is different from a listing that is switched off — those
          still have a page, marked as unbuyable, because the record behind them is public.
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/marketplace" className="btn">
              Marketplace
            </Link>
            <Link href="/leaderboard" className="btn">
              Leaderboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
