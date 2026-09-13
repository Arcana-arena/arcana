'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The nav, folded behind one button on a phone.
 *
 * On a 390px screen the five nav entries, the create button and the session
 * pill do not fit in one row, and the bar wrapped to 98px — a quarter of the
 * first screen spent on chrome. Below 720px the inline nav is hidden and this
 * is shown instead (globals.css); above it this renders nothing visible.
 *
 * A CLIENT COMPONENT BECAUSE IT HAS TO CLOSE. A <details> element would open
 * without JavaScript, but Next navigates between pages without a reload, the
 * header is reconciled rather than replaced, and the menu would still be open
 * on top of the page it just opened. Closing on a pathname change is the one
 * thing this needs the browser for.
 */
export function MobileMenu({ items, current }: { items: Array<{ label: string; href: string }>; current?: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="hdr-menu">
      <button
        type="button"
        className="btn hdr-menu-btn"
        aria-expanded={open}
        aria-controls="hdr-menu-panel"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Close' : 'Menu'}
      </button>
      {open ? (
        <nav id="hdr-menu-panel" className="hdr-menu-panel">
          {items.map((i) => (
            <Link
              key={i.label}
              href={i.href}
              aria-current={current === i.label ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {i.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
