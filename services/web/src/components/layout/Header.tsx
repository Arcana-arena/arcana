/**
 * The bar at the top of every page.
 *
 * TWO THINGS IN THE MOCKUP ARE NOT HERE, AND THEIR ABSENCE IS VISIBLE. The
 * mockups show a live chain readout ("4663 · #8,214,006 · 41ms") and a wallet
 * pill. The chain height and RPC latency are not exposed by any endpoint this
 * surface can read, and the wallet belongs to Stage 4. Rather than print a
 * plausible block number — which would be the single most convincing lie on the
 * page, since the footer of every mockup says "every number on this page is
 * read from the chain" — the readout shows the chain id it is configured for
 * and says the height is not being read.
 *
 * Two of the five nav entries have no page yet. They are rendered as disabled
 * text rather than as links to a 404, and they say why on hover.
 */
import Link from 'next/link';

const CHAIN_ID = process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663';

type NavItem = { label: string; href: string | null; note?: string };

const NAV: NavItem[] = [
  { label: 'Leaderboard', href: '/leaderboard' },
  { label: 'Agents', href: null, note: 'No agent directory yet — open an agent from the leaderboard or the marketplace.' },
  { label: 'Marketplace', href: '/marketplace' },
  { label: 'Seasons', href: '/seasons' },
  { label: 'Docs', href: null, note: 'Not published on this surface yet.' },
];

export function Header({ current }: { current?: string }) {
  return (
    <header className="hdr">
      <Link href="/" className="hdr-brand" style={{ color: 'var(--color-text)' }}>
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            border: '2px solid var(--color-accent)',
            display: 'inline-block',
            transform: 'rotate(45deg)',
          }}
        />
        <span className="hdr-word">ARCANA</span>
      </Link>
      <nav className="hdr-nav">
        {NAV.map((n) =>
          n.href ? (
            <Link key={n.label} href={n.href} aria-current={current === n.label ? 'page' : undefined}>
              {n.label}
            </Link>
          ) : (
            <span key={n.label} className="m3" style={{ padding: '15px 0 13px', cursor: 'not-allowed' }} title={n.note}>
              {n.label}
            </span>
          ),
        )}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          className="mono m2"
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
          title="The chain id this deployment is configured for. Block height and RPC latency are not exposed by any read endpoint, so they are not shown — a number here that nothing measured would be the least honest pixel on the page."
        >
          <span style={{ width: 6, height: 6, background: 'var(--color-accent)' }} className="pulse" />
          {CHAIN_ID}
          <span className="m3">·</span>
          <span className="m3">height not read</span>
        </div>
        <span
          className="btn"
          aria-disabled="true"
          title="Signing in arrives with Stage 4. Everything on this surface is readable without a wallet, on purpose."
        >
          Connect wallet
        </span>
      </div>
    </header>
  );
}
