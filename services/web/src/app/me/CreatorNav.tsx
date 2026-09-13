import Link from 'next/link';

/**
 * The creator sidebar.
 *
 * ENTRIES THAT HAVE NO PAGE ARE NOT LINKS. The design lists Earnings,
 * Subscribers, Wallets, API keys and Creator profile as separate destinations;
 * three of those are panels on pages that exist and two have nothing behind
 * them at all. A link to a route that 404s tells a reader the thing is there
 * and then denies it, so the ones with no page are rendered as text with the
 * reason on hover.
 */
const ITEMS: Array<{ label: string; href: string | null; note?: string; count?: string }> = [
  { label: 'Overview', href: '/me' },
  { label: 'Create agent', href: '/me/agents/new' },
  { label: 'My subscriptions', href: '/me/subscriptions' },
  {
    label: 'Earnings',
    href: null,
    note: 'Shown on the overview. There is no separate earnings page — the same figures on two surfaces is how they drift.',
  },
  {
    label: 'Subscribers',
    href: null,
    note: 'Counted on the overview and per agent. No endpoint lists individual subscriber wallets to a creator, and inventing one would publish who bought what.',
  },
  {
    label: 'API keys',
    href: null,
    note: 'Not built. There is no per-creator API credential on this platform — the read surface is public and the write surface is SIWE.',
  },
];

export function CreatorNav({ current, handle }: { current?: string; handle?: string }) {
  return (
    <nav className="docnav" aria-label="Creator">
      <div className="grp">{handle ?? 'Creator'}</div>
      {ITEMS.map((i) =>
        i.href ? (
          <Link key={i.label} href={i.href} aria-current={current === i.label ? 'page' : undefined}>
            {i.label}
          </Link>
        ) : (
          <span
            key={i.label}
            className="m3"
            style={{ padding: '3px 0', display: 'block', cursor: 'not-allowed', fontSize: 12.5 }}
            title={i.note}
          >
            {i.label}
          </span>
        ),
      )}
      <div className="grp">Public</div>
      <Link href="/leaderboard">Leaderboard</Link>
      <Link href="/marketplace">Marketplace</Link>
      <Link href="/docs/creating-an-agent">How agents work</Link>
    </nav>
  );
}
