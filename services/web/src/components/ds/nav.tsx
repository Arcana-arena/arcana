/**
 * Tabs, segmented controls and pagination — all of them links.
 *
 * WHY LINKS AND NOT STATE. Every one of these changes WHICH ROWS the backend
 * should return. If a tab were client state, the page would have to hold all
 * seven categories at once and pick between them in the browser — which is
 * ordering in the client under another name, and the ordering is the backend's
 * to decide. A link re-asks the question and prints the answer.
 *
 * It also means every view has a URL: a rank you can send to someone is a rank
 * they can check.
 */
import Link from 'next/link';

export type TabDef = { key: string; label: string; href: string; about?: string };

export function Tabs({ tabs, current }: { tabs: TabDef[]; current: string }) {
  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className="tab"
          title={t.about}
          aria-current={t.key === current ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Seg({ tabs, current }: { tabs: TabDef[]; current: string }) {
  return (
    <div className="seg">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className="seg-opt"
          title={t.about}
          aria-current={t.key === current ? 'true' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Pagination that states the whole size, not just the page.
 *
 * `total` and `total_pages` come from the response. They are not derived here —
 * if the backend did not send them the control says so instead of guessing from
 * the length of the array it happens to be holding, which would silently turn
 * "page 1 of 9" into "1 of 1".
 */
export function Pager({
  page,
  pageSize,
  total,
  totalPages,
  hrefFor,
  unit = 'rows',
}: {
  page: number;
  pageSize: number;
  total: number | null | undefined;
  totalPages: number | null | undefined;
  hrefFor: (page: number) => string;
  unit?: string;
}) {
  const known = typeof total === 'number' && typeof totalPages === 'number';
  const first = (page - 1) * pageSize + 1;
  const last = known ? Math.min(page * pageSize, total) : null;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
        padding: '16px 0 32px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--ink-2)',
      }}
    >
      <span>
        {known ? (
          <>
            {first}&ndash;{last} of {total} {unit}
          </>
        ) : (
          <span className="m3">the response did not carry a total, so the size of this list is unknown</span>
        )}
      </span>
      <span style={{ display: 'flex', gap: 4 }}>
        <Link
          href={hrefFor(page - 1)}
          className="btn"
          style={{ padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          aria-disabled={page <= 1 ? 'true' : undefined}
        >
          &lsaquo;
        </Link>
        <span
          className="btn btn-primary"
          style={{ padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}
        >
          {page}
        </span>
        <Link
          href={hrefFor(page + 1)}
          className="btn"
          style={{ padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          aria-disabled={known && totalPages !== null && page >= (totalPages as number) ? 'true' : undefined}
        >
          &rsaquo;
        </Link>
      </span>
      <span className="m3">
        {known ? (
          <>
            page {page} of {totalPages} &middot; {pageSize} / page
          </>
        ) : (
          <>{pageSize} / page</>
        )}
      </span>
    </div>
  );
}
