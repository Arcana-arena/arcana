/**
 * The states that are not the happy path — and the reason they are components
 * rather than an afterthought.
 *
 * A page has at least five outcomes and only one of them is "here are the rows":
 * it is still loading, the service did not answer, the query was valid but
 * matched nothing, the thing exists but has not been measured yet, and the
 * thing exists but the measurement is unavailable right now. Four of those look
 * identical if you render an empty table, and an empty table reads as "zero
 * agents qualify", which is a claim.
 *
 * So each one is spelled out, and each one says WHY. `Failed` in particular
 * never degrades into an empty list: if a read did not succeed, the page says
 * the read did not succeed.
 */
import type { ReactNode } from 'react';
import type { Err } from '@/lib/api';

export function Callout({
  children,
  tone = 'note',
}: {
  children: ReactNode;
  tone?: 'note' | 'warn' | 'bad';
}) {
  return <div className={`callout callout-${tone}`}>{children}</div>;
}

export function StatusBox({
  title,
  children,
  bad = false,
}: {
  title: string;
  children?: ReactNode;
  bad?: boolean;
}) {
  return (
    <div className={`status ${bad ? 'status-bad' : ''}`}>
      <div className="status-title">{title}</div>
      {children ? <div className="status-body">{children}</div> : null}
    </div>
  );
}

/**
 * A read that did not come back.
 *
 * It prints the status code and the service's own words. "Something went wrong"
 * tells a reader nothing and tells whoever has to fix it less; the reason the
 * backend gave is the most useful sentence available and it is free.
 */
export function Failed({ what, error }: { what: string; error: Err }) {
  return (
    <StatusBox title={`${what} could not be read`} bad>
      {error.status === null
        ? `The service did not answer: ${error.reason}`
        : `The service answered ${error.status}: ${error.reason}`}
      <div className="mono m3" style={{ marginTop: 8, fontSize: 11 }}>
        Nothing is shown below rather than an empty list, because an empty list here would mean
        &ldquo;there are none&rdquo; and that is not what happened.
      </div>
    </StatusBox>
  );
}

/** A query that worked and matched nothing. Different from Failed, on purpose. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <StatusBox title={title}>{children}</StatusBox>;
}

/**
 * A row of shimmer, for the moment before a server-rendered page arrives.
 *
 * These pages render on the server, so a visitor sees this only through
 * Next's streaming boundary — but the boundary exists, and what it shows while
 * a slow database answers should look like waiting rather than like emptiness.
 */
export function SkeletonRows({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  const widths = ['14px', '60%', '100%', '100%', '100%', '100%', '80%', '50%'];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `30px 1fr ${Array.from({ length: Math.max(0, cols - 2) }).map(() => '90px').join(' ')}`,
        gap: '10px 12px',
        alignItems: 'center',
        padding: '12px 0',
      }}
    >
      {Array.from({ length: rows * cols }).map((_, i) => (
        <span key={i} className="sk" style={{ width: widths[i % cols] ?? '100%' }} />
      ))}
    </div>
  );
}

export function SkeletonBlock({ height = 200 }: { height?: number }) {
  return <span className="sk" style={{ height, width: '100%' }} />;
}

/**
 * A value the backend explicitly told us it could not obtain.
 *
 * price_status is the reason this exists. A decision can carry `price: null`
 * with `price_status: "unavailable"`, and printing 0.00 there would invent a
 * price of zero for a share of Apple.
 */
export function Unavailable({ reason }: { reason?: string | null }) {
  return (
    <span className="mono m3" title={reason || 'The backend reported this value as unavailable.'}>
      unavailable
    </span>
  );
}
