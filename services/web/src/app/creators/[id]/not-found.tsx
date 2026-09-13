import Link from 'next/link';

/**
 * A creator id that names nobody.
 *
 * Different from a creator who exists and has built nothing: that one has a
 * page, with a counted zero on it.
 */
export default function CreatorNotFound() {
  return (
    <div style={{ padding: '64px 32px', maxWidth: 680, margin: '0 auto' }}>
      <div className="status">
        <div className="status-title">No creator at this address</div>
        <div className="status-body">
          No creator profile exists with this id. That is different from a creator who has never created an agent —
          they have a page, and it says so.
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/leaderboard" className="btn">
              Leaderboard
            </Link>
            <Link href="/marketplace" className="btn">
              Marketplace
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
