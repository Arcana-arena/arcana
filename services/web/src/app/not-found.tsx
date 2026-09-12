import Link from 'next/link';

/**
 * A URL that names nothing.
 *
 * It says the address matched no record — not that the record is empty.
 */
export default function NotFound() {
  return (
    <div style={{ padding: '64px 32px', maxWidth: 680, margin: '0 auto' }}>
      <div className="status">
        <div className="status-title">Nothing is published at this address</div>
        <div className="status-body">
          The path matched no page and no record. That is different from a record that exists and is empty.
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/leaderboard" className="btn">
              Leaderboard
            </Link>
            <Link href="/marketplace" className="btn">
              Marketplace
            </Link>
            <Link href="/seasons" className="btn">
              Seasons
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
