import { SkeletonRows } from '@/components/ds/states';

/**
 * What a reader sees while the server is still asking.
 *
 * Shimmer, not an empty table. The distinction is the whole point of this
 * surface: an empty table says "there are none", and while a query is still
 * running nobody knows that yet.
 */
export default function Loading() {
  return (
    <div style={{ padding: '32px' }}>
      <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            border: '1.5px solid var(--ink-2)',
            borderRightColor: 'transparent',
            borderRadius: '50%',
            display: 'inline-block',
          }}
        />
        reading
      </div>
      <SkeletonRows rows={8} cols={6} />
    </div>
  );
}
