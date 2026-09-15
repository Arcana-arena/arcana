import Link from 'next/link';

/**
 * The creator sidebar.
 *
 * ONLY PLACES THAT EXIST. It used to list Earnings, Subscribers and API keys as
 * disabled text with the reason on hover — three entries a newcomer reads as
 * features and cannot open. Earnings has its own page now; subscriber counts
 * are on it and on each agent; API keys do not exist on this platform, and a
 * greyed-out promise of them is not information anybody acts on.
 */
const ITEMS: Array<{ label: string; href: string }> = [
  { label: 'Dashboard', href: '/me' },
  { label: 'Portfolio', href: '/me/portfolio' },
  { label: 'Create agent', href: '/me/agents/new' },
  { label: 'Earnings', href: '/me/earnings' },
  { label: 'My subscriptions', href: '/me/subscriptions' },
];

export function CreatorNav({
  current,
  handle,
  creatorId,
}: {
  current?: string;
  handle?: string;
  /** Needed for the one Account entry that has a page: the public profile. */
  creatorId?: string;
}) {
  return (
    <nav className="docnav" aria-label="Creator">
      <div className="grp">{handle ?? 'Creator'}</div>
      {ITEMS.map((i) => (
        <Link key={i.label} href={i.href} aria-current={current === i.label ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
      {/*
        THE PROFILE EVERYONE ELSE READS, linked from the account that owns it.
        It is the same public page a buyer lands on from a listing — there is no
        private version. A wallet with no profile row yet has no id, so the entry
        is simply not shown rather than linking somewhere that answers 404.
      */}
      {creatorId ? (
        <>
          <div className="grp">Account</div>
          <Link href={`/creators/${creatorId}`} aria-current={current === 'Creator profile' ? 'page' : undefined}>
            Creator profile
          </Link>
        </>
      ) : null}

      <div className="grp">Help</div>
      <Link href="/docs/creating-an-agent">How agents work</Link>
    </nav>
  );
}
