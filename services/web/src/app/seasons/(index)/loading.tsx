import { SkeletonBlock } from '@/components/ds/states';

/**
 * Scoped to the seasons INDEX, not to a season's own page.
 *
 * A loading.tsx here would wrap /seasons/[id] too, and a Suspense boundary
 * starts the response before the page resolves — which means a later
 * notFound() can no longer set the status, and an unknown season id would be
 * served with a 200. That exact regression happened on the marketplace. The
 * index calls no notFound(), so a boundary on it is safe; the detail route
 * keeps none.
 */
export default function Loading() {
  return (
    <div className="sec" style={{ paddingTop: 32, paddingBottom: 44, borderBottom: 'none' }}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 18 }}>
        reading the arenas…
      </div>
      <SkeletonBlock height={220} />
    </div>
  );
}
