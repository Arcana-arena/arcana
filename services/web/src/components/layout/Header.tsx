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
import { getSession } from '@/lib/session';
import { addr } from '@/lib/format';

const CHAIN_ID = process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663';

type NavItem = { label: string; href: string | null; note?: string };

const NAV: NavItem[] = [
  { label: 'Leaderboard', href: '/leaderboard' },
  { label: 'Agents', href: null, note: 'No agent directory yet — open an agent from the leaderboard or the marketplace.' },
  { label: 'Marketplace', href: '/marketplace' },
  { label: 'Seasons', href: '/seasons' },
  { label: 'Docs', href: null, note: 'Not published on this surface yet.' },
];

export async function Header({ current }: { current?: string }) {
  return (
    <header className="hdr">
      <Link href="/" className="hdr-brand" style={{ color: 'var(--color-text)' }}>
        {/*
          THE ACTUAL MARK, not a CSS lozenge standing in for one. A plain <img>
          rather than next/image: it is one small fixed-size asset on every page,
          so there is nothing for an optimiser to decide, and next/image would
          add a runtime dependency on sharp to resize a file that is already the
          right size. width/height are set so it reserves its space and the
          header does not jump as it loads.
        */}
        <img
          src="/arcana-mark.png"
          alt=""
          width={24}
          height={24}
          style={{ display: 'block' }}
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
        <SessionPill />
      </div>
    </header>
  );
}

/**
 * Signed in, signed out, or not known — three states, three pills.
 *
 * "Not known" is the one that matters. When a session cookie exists but the
 * auth service cannot be reached to confirm it, showing "Connect wallet" would
 * tell somebody they are logged out when the truth is that nobody can currently
 * say. They would sign in again, against a service that is down, and the page
 * would be the reason they thought that was the problem.
 */
async function SessionPill() {
  const s = await getSession();

  if (s.state === 'signed_in') {
    return (
      <Link
        href="/me"
        className="btn"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, gap: 8 }}
        title={s.session.wallet_address}
      >
        <span style={{ width: 8, height: 8, background: 'var(--color-accent)' }} />
        {addr(s.session.wallet_address)}
      </Link>
    );
  }

  if (s.state === 'unknown') {
    return (
      <span
        className="btn"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, gap: 8, borderStyle: 'dashed' }}
        title={`A session cookie is present and could not be confirmed: ${s.reason}. This is not the same as being signed out.`}
      >
        <span style={{ width: 8, height: 8, background: 'var(--amber)' }} />
        session unconfirmed
      </span>
    );
  }

  return (
    <Link href="/signin" className="btn">
      Sign in
    </Link>
  );
}
