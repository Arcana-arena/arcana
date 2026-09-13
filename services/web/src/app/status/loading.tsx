import { SkeletonBlock } from '@/components/ds/states';

/**
 * What the boundary shows while the probes run.
 *
 * Deliberately not a row of green badges waiting to be corrected. This page's
 * whole claim is that a check which did not run is not a check that passed, and
 * an optimistic skeleton would break that claim before the data arrives.
 */
export default function Loading() {
  return (
    <div className="sec" style={{ paddingTop: 32, paddingBottom: 44, borderBottom: 'none' }}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 18 }}>
        running the probes… nothing below is a verdict yet
      </div>
      <SkeletonBlock height={320} />
    </div>
  );
}
