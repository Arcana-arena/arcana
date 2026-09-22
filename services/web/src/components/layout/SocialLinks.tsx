/**
 * The accounts ARCANA speaks from, as marks rather than as words.
 *
 * ONE COMPONENT, BOTH FOOTERS. There are two — the landing page has its own —
 * and the X link was once written into one of them and not the other, so it
 * was missing from the page most people see first. Written once here so they
 * cannot drift again, and so adding a fourth account is one entry rather than
 * two edits.
 *
 * INLINE SVG, NOT IMAGE FILES. Each is a single path. Three <img> tags would
 * be three requests and three fixed colours; these inherit `currentColor`, so
 * they are the same ink as the footer around them in both themes and need no
 * dark-mode variants.
 *
 * EVERY ONE CARRIES rel="noopener". Without it the opened page can reach back
 * through window.opener and navigate this tab somewhere else. These are the
 * only links on the site that leave it.
 *
 * THE LABEL IS NOT DECORATIVE. A glyph carries no text, so `aria-label` is the
 * only thing a screen reader has — an icon link with nothing but a path in it
 * is announced as "link" and nothing else.
 */

type Social = { name: string; href: string; handle: string; path: string };

/** Add an account here and both footers get it. */
const ACCOUNTS: Social[] = [
  {
    name: 'X',
    href: 'https://x.com/Arcana_Arena',
    handle: '@Arcana_Arena',
    path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  },
  {
    name: 'Telegram',
    href: 'https://t.me/ArcanaArena_void',
    handle: 't.me/ArcanaArena_void',
    path: 'M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z',
  },
  {
    name: 'GitHub',
    href: 'https://github.com/Arcana-arena',
    handle: 'github.com/Arcana-arena',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
];

export function SocialLinks({ size = 15, gap = 14 }: { size?: number; gap?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
      {ACCOUNTS.map((a) => (
        <a
          key={a.name}
          href={a.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`ARCANA on ${a.name}`}
          title={a.handle}
          className="x-link"
          style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
        >
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
            <path d={a.path} />
          </svg>
        </a>
      ))}
    </span>
  );
}
