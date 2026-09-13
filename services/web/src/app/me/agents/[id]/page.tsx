import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { addr, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Tag } from '@/components/ds/primitives';
import { Callout, Failed, StatusBox } from '@/components/ds/states';

/**
 * An agent's trading wallet — whose key it is, and who else can sign.
 *
 * OWNER ONLY, AND THE PAGE DOES NOT PRETEND OTHERWISE. An address is public on
 * chain, but the map from agent to address is not: publishing it would let
 * anyone watch a specific person's positions in real time. A caller who is not
 * the owner gets the service's refusal printed as a refusal, not as an empty
 * page.
 *
 * KEY CUSTODY IS THE HEADLINE, not a footnote. "shared" means the creator holds
 * the key too and can move funds without going through ARCANA — including while
 * a position is open. That changes what every other number on this platform
 * means for this agent, so it is stated at the top, in the service's own words.
 *
 * NO KEY MATERIAL IS SHOWN OR REQUESTED HERE. Export is a rate-limited POST that
 * returns a private key once; it is deliberately not wired into this page,
 * because a button that hands out key material should not be one stray click
 * from a dashboard.
 */
export const dynamic = 'force-dynamic';

type Wallet = {
  agent_id: string;
  address: string;
  provenance: string | null;
  key_custody: string | null;
  exported_at: string | null;
  imported_at: string | null;
  note: string | null;
};

type Agent = {
  id: string;
  name: string;
  version: number;
  status: string;
  strategyType: string | null;
  assetUniverse: string | null;
};

export default async function AgentWalletPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();

  if (s.state === 'signed_out') redirect(`/signin?next=%2Fme%2Fagents%2F${encodeURIComponent(id)}`);

  if (s.state === 'unknown') {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ padding: '48px 32px', borderBottom: 'none' }}>
          <StatusBox title="We could not confirm your session" bad>
            {s.reason}. Nothing has been cleared, and you are not being told you are signed out.
          </StatusBox>
        </div>
        <Footer />
      </div>
    );
  }

  const [walletR, agentR] = await Promise.all([
    authed<Wallet>(`/v1/agents/${id}/wallet`),
    authed<Agent>(`/v1/agents/${id}`),
  ]);

  const shared = walletR.ok && walletR.data.key_custody === 'shared';

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 28, paddingBottom: 18, borderBottom: 'none' }}>
        <Link href="/me" style={{ fontSize: 12 }}>
          ← Overview
        </Link>
        <h1 style={{ marginTop: 8 }}>{agentR.ok ? agentR.data.name : id.slice(0, 8)}</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 4 }}>
          trading wallet and key custody
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none', display: 'grid', gap: 18 }}>
        {!walletR.ok ? (
          walletR.status === 403 || walletR.status === 404 ? (
            <StatusBox title="This agent is not yours" bad>
              The service refused: {walletR.reason}
              <div style={{ marginTop: 10 }}>
                Which address belongs to which agent is deliberately not public — publishing it would let anyone watch
                a specific person&rsquo;s positions as they happen.
              </div>
            </StatusBox>
          ) : (
            <Failed what="This agent's wallet" error={{ ok: false, status: walletR.status, reason: walletR.reason }} />
          )
        ) : (
          <>
            {shared ? (
              <Callout tone="warn">
                <strong>You hold this key as well as ARCANA.</strong> Funds can leave this wallet without going
                through the platform, including while a position is open. ARCANA reads the chain rather than assuming,
                and reconciles its record to what it finds.
              </Callout>
            ) : null}

            <div className="stat-grid" style={{ border: '1px solid var(--color-divider)' }}>
              <div className="stat-cell">
                <Key>Address</Key>
                <div className="stat-value" style={{ fontSize: 16 }} title={walletR.data.address}>
                  {addr(walletR.data.address)}
                </div>
                <div className="stat-sub">public on chain</div>
              </div>
              <div className="stat-cell">
                <Key>Key custody</Key>
                <div className="stat-value" style={{ fontSize: 16 }}>
                  {walletR.data.key_custody ?? <span className="m3">not reported</span>}
                </div>
                <div className="stat-sub">
                  {shared ? 'you and ARCANA can both sign' : 'ARCANA is currently the only party that can sign'}
                </div>
              </div>
              <div className="stat-cell">
                <Key>Exported</Key>
                <div className="stat-value" style={{ fontSize: 16 }}>
                  {walletR.data.exported_at ? (
                    utc(walletR.data.exported_at)
                  ) : (
                    <span className="m3" title="The key has never been handed out. This is a recorded never, not a missing value.">
                      never
                    </span>
                  )}
                </div>
              </div>
              <div className="stat-cell">
                <Key>Imported</Key>
                <div className="stat-value" style={{ fontSize: 16 }}>
                  {walletR.data.imported_at ? (
                    utc(walletR.data.imported_at)
                  ) : (
                    <span className="m3">never</span>
                  )}
                </div>
              </div>
            </div>

            <div>
              <Lbl>FULL ADDRESS</Lbl>
              <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all', marginTop: 4 }}>
                {walletR.data.address}
              </div>
            </div>

            {walletR.data.provenance ? (
              <div>
                <Lbl>WALLET PROVENANCE</Lbl>
                <div style={{ marginTop: 4 }}>
                  <Tag tone="outline">{walletR.data.provenance}</Tag>
                </div>
              </div>
            ) : null}

            {walletR.data.note ? <Callout tone="note">{walletR.data.note}</Callout> : null}

            <Callout tone="note">
              <strong>Taking possession of the key is not a button here.</strong> Export returns private key material
              once and is rate limited to three calls an hour for that reason; it is{' '}
              <span className="mono">POST /v1/agents/:id/wallet/export</span>. Putting it a stray click from a
              dashboard is how a stolen session becomes a stolen wallet.
            </Callout>
          </>
        )}
      </div>

      <Footer note="an agent's address is public on chain; which agent holds it is not" />
    </div>
  );
}
