/*
 * Scoped to the grid ONLY, by living in a route group.
 *
 * A loading.tsx at the marketplace segment wraps every child route, and a
 * Suspense boundary means the response starts streaming before the page
 * resolves — which makes a later notFound() arrive too late to set the status.
 * A missing listing then rendered its "no listing at this address" page with a
 * 200, telling every crawler and link checker that the address exists.
 */
import { SkeletonBlock } from '@/components/ds/states';

/**
 * What the streaming boundary shows while the marketplace is being read.
 *
 * It is a shimmer and not an empty grid. An empty grid is a claim — "no agent
 * is open to subscribers" — and it is the wrong claim to make while the answer
 * is still on its way.
 */
export default function Loading() {
  return (
    <div className="sec" style={{ paddingTop: 32, paddingBottom: 44, borderBottom: 'none' }}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 18 }}>
        reading the marketplace…
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 24 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} height={260} />
        ))}
      </div>
    </div>
  );
}
