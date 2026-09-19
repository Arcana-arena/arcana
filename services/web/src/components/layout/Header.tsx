/**
 * The bar at the top of every page.
 *
 * THE CHAIN READOUT IS A REAL BLOCK. It shows the highest block ARCANA has a
 * settled transaction in, counted by /v1/stats. It is deliberately NOT called
 * the chain head: nothing here polls the node, and a plausible height would be
 * the least honest pixel on a site whose whole claim is that its numbers are
 * read rather than produced.
 *
 * A nav entry with no page is rendered as disabled text rather than as a link
 * to a 404, and says why on hover. None is disabled now: "Agents" was, for as
 * long as /agents did not exist.
 *
 * SIGNED IN, THE FIRST THING OFFERED IS THE DASHBOARD. Somebody who has just
 * connected a wallet came to look after their agents. The door used to be the
 * wallet-address pill, which does link to /me but reads as an address, not as a
 * place to go. So a signed-in visitor gets a labelled Dashboard button — or,
 * with no creator profile yet, "Set up profile", which lands on the form that
 * creates one rather than on an empty page.
 *
 * "CREATE AN AGENT" IS ON EVERY PAGE. The form sends a signed-out visitor to
 * sign in and back again, so the link is the same for everyone. Signed in, it
 * steps back to a secondary button beside the Dashboard.
 *
 * ON A PHONE THE NAV FOLDS INTO A MENU (MobileMenu), so the bar stays one row.
 * The Dashboard button stays in the bar; Create an agent moves into the menu.
 */
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { agent } from '@/lib/api';
import { addr, int } from '@/lib/format';
import { MobileMenu } from './MobileMenu';

const CHAIN_ID = process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663';

type SessionState = Awaited<ReturnType<typeof getSession>>;

type NavItem = { label: string; href: string | null; note?: string };

const NAV: NavItem[] = [
  { label: 'Leaderboard', href: '/leaderboard' },
  { label: 'Agents', href: '/agents' },
  { label: 'Marketplace', href: '/marketplace' },
  { label: 'Theses', href: '/theses' },
  { label: 'Seasons', href: '/seasons' },
  { label: 'Docs', href: '/docs' },
];

export async function Header({ current }: { current?: string }) {
  // The latest block ARCANA has a settled transaction in. It is a real number
  // now that /v1/stats counts it; the readout used to say "height not read"
  // because nothing published one, and a plausible block number would have been
  // the least honest pixel on the page.
  const [stats, s] = await Promise.all([
    agent<{ chain: { id: number; last_block_seen: number | null } }>('/v1/stats'),
    getSession(),
  ]);
  const signedIn = s.state === 'signed_in';
  const door = signedIn
    ? s.session.creator_id
      ? { label: 'Dashboard', href: '/me' }
      : { label: 'Set up profile', href: '/me' }
    : null;

  const menuItems = [
    ...(door ? [door, { label: 'Create an agent', href: '/me/agents/new' }] : []),
    ...NAV.filter((n): n is NavItem & { href: string } => n.href !== null).map((n) => ({ label: n.label, href: n.href })),
  ];

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
      <div className="hdr-right" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          className="mono m2 hdr-chain"
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
          title="The chain, and the highest block ARCANA has a settled transaction in. It is not the chain head: nothing here polls the node for that."
        >
          <span style={{ width: 6, height: 6, background: 'var(--color-accent)' }} className="pulse" />
          {stats.ok ? stats.data.chain.id : CHAIN_ID}
          <span className="m3">·</span>
          {stats.ok && stats.data.chain.last_block_seen !== null ? (
            <span>#{int(stats.data.chain.last_block_seen)}</span>
          ) : (
            <span className="m3">no block recorded</span>
          )}
        </div>
        {door ? (
          <>
            <Link href="/me/agents/new" className="btn hdr-cta hdr-cta-secondary" style={{ fontSize: 12 }}>
              Create an agent
            </Link>
            <Link href={door.href} className="btn btn-primary hdr-cta hdr-dash" style={{ fontSize: 12 }}>
              {door.label}
            </Link>
          </>
        ) : (
          <Link href="/me/agents/new" className="btn btn-primary hdr-cta" style={{ fontSize: 12 }}>
            Create an agent
          </Link>
        )}
        <SessionPill s={s} />
        <MobileMenu current={current} items={menuItems} />
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
function SessionPill({ s }: { s: SessionState }) {
  if (s.state === 'signed_in') {
    return (
      <Link
        href="/me"
        className="btn hdr-pill"
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
        className="btn hdr-pill"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, gap: 8, borderStyle: 'dashed' }}
        title={`A session cookie is present and could not be confirmed: ${s.reason}. This is not the same as being signed out.`}
      >
        <span style={{ width: 8, height: 8, background: 'var(--amber)' }} />
        session unconfirmed
      </span>
    );
  }

  return (
    <Link href="/signin" className="btn hdr-pill">
      Sign in
    </Link>
  );
}
