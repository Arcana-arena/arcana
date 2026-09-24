/**
 * ARCANA CAPITAL — every agent's borrowing, on one page, with the controls.
 *
 * For each of the owner's agents: what it has posted and owes on Morpho, its
 * health factor on the oracle and on the worse of the oracle and pool, the
 * price that liquidates it, its capital decisions (the mandate's and the
 * owner's), and the four things the owner can do by hand — post collateral,
 * borrow, repay, and take collateral back. The mandate is written on the
 * agent's own manage page and linked from here; this page is where the position
 * is looked after.
 *
 * NOTHING HERE IS COMPUTED THAT THE ENGINE DOES NOT ALSO ENFORCE. The two
 * figures derived on this page — how much more can be borrowed, and how much
 * collateral can come back, before the floor — are conveniences for filling the
 * box; the engine recomputes it from the
 * chain and refuses anything past it, whatever this page showed.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { agent as publicRead } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../CreatorNav';
import type { Dashboard, WalletBalances } from '../shapes';
import type { CapitalMandateView } from '../agents/[id]/actions';
import { CapitalBlock } from '../../agents/[id]/tabs/Capital';
import { ManualCapitalPanel } from './ManualCapitalPanel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ARCANA CAPITAL — ARCANA' };

type CapitalRead = {
  positions: Array<{
    collateral: { symbol: string; quantity: number };
    debt_usdg: number;
    lltv: number;
    prices: { oracle_usdg: number; pool_usdg: number | null };
  }>;
  mandate: { status: string } | null;
};

/** The owner's floor when no mandate sets one; the engine's OwnerFloor. */
const OWNER_FLOOR = 1.5;
/** The engine keeps a borrow 0.1% inside the floor (capital.floorMargin). */
const FLOOR_MARGIN = 0.999;

export default async function CapitalPage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fcapital');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared.
        </StatusBox>
      </Shell>
    );
  }
  const { creator_id } = s.session;
  const operator = s.session.is_operator === true;
  if (!creator_id) {
    return (
      <Shell operator={operator}>
        <h1>ARCANA CAPITAL</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            <strong>This wallet has no creator profile yet.</strong> <Link href="/me">Set it up</Link>, create an
            agent with a wallet, and its borrowing will be managed here.
          </Callout>
        </div>
      </Shell>
    );
  }

  const dash = await authed<Dashboard>(`/v1/creators/${creator_id}/dashboard`);
  if (!dash.ok) {
    return (
      <Shell creatorId={creator_id} operator={operator}>
        <h1>ARCANA CAPITAL</h1>
        <Failed what="Your agents" error={dash} />
      </Shell>
    );
  }
  const agents = dash.data.agents.filter((a) => a.status !== 'draft');

  const rows = await Promise.all(
    agents.map(async (a) => {
      const [cap, bal, man] = await Promise.all([
        publicRead<CapitalRead>(`/v1/agents/${a.id}/capital`),
        authed<WalletBalances>(`/v1/agents/${a.id}/wallet/balances`),
        authed<CapitalMandateView>(`/v1/agents/${a.id}/capital/mandate`),
      ]);
      return { a, cap, bal, man };
    }),
  );
  const limits = rows.find((r) => r.man.ok)?.man;
  const lim = limits && limits.ok ? limits.data.limits : null;

  return (
    <Shell creatorId={creator_id} operator={operator}>
      <h1>ARCANA CAPITAL</h1>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 680, lineHeight: 1.6 }}>
        Borrow USDG against {lim?.market?.name ? <span className="mono">{lim.market.name}</span> : 'a Stock Token'} on
        Morpho, without selling it. Each agent borrows into its own wallet only. A mandate on the agent&rsquo;s manage
        page runs this on the agent&rsquo;s cadence; the controls below do it by hand. Both are held to the same rule:
        the platform caps ({lim ? `${lim.platform_max_borrow_per_tx_usdg} USDG a borrow, ${lim.platform_max_debt_usdg} per agent` : 'per borrow and per agent'}),
        a health-factor floor on the worse of the oracle and pool price, and a trusted oracle.
      </div>

      {lim && !lim.lending_enabled ? (
        <div style={{ marginTop: 14 }}>
          <Callout tone="warn">
            <strong>Lending is switched off on the platform.</strong> Every action below will be refused by the signer
            and nothing will be signed.
          </Callout>
        </div>
      ) : null}

      {agents.length === 0 ? (
        <div style={{ marginTop: 18 }}>
          <Empty title="No agents yet">An active agent with a wallet is what borrows. <Link href="/me/agents/new">Create one</Link>.</Empty>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 22, marginTop: 20 }}>
        {rows.map(({ a, cap, bal, man }) => {
          const hasWallet = bal.ok ? bal.data.has_wallet : false;
          const walletUSDG = bal.ok && bal.data.token?.available && bal.data.token.amount !== null ? Number(bal.data.token.amount) : null;
          const mandate = man.ok ? man.data.mandate : null;
          const floor = mandate?.min_health_factor ?? OWNER_FLOOR;
          const pos = cap.ok ? cap.data.positions[0] : undefined;
          let headroom: number | null = null;
          let withdrawMax: number | null = null;
          if (cap.ok) {
            if (!pos) {
              headroom = 0;
              withdrawMax = 0;
            } else {
              const worst = Math.min(pos.prices.oracle_usdg, pos.prices.pool_usdg ?? pos.prices.oracle_usdg);
              const ceiling = Math.min(
                (pos.collateral.quantity * worst * pos.lltv) / floor * FLOOR_MARGIN,
                mandate?.max_borrow_usdg ?? lim?.platform_max_debt_usdg ?? 0,
                lim?.platform_max_debt_usdg ?? 0,
              );
              headroom = Math.max(0, Math.min(ceiling - pos.debt_usdg, lim?.platform_max_borrow_per_tx_usdg ?? 0));
              // What must stay posted to keep the worst-case health factor at the
              // floor, 0.1% over it; with no debt, nothing must stay.
              const mustStay = pos.debt_usdg > 0 ? (pos.debt_usdg * floor) / (worst * pos.lltv) / FLOOR_MARGIN : 0;
              withdrawMax = Math.max(0, pos.collateral.quantity - mustStay);
            }
          }
          return (
            <section key={a.id} className="box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ fontSize: 15 }}>{a.name}</strong>{' '}
                  <span className="mono m3" style={{ fontSize: 11 }}>{a.status}</span>
                </div>
                <div className="mono" style={{ fontSize: 11 }}>
                  mandate {mandate ? `${mandate.status} · floor ${mandate.min_health_factor} · cap ${mandate.max_borrow_usdg} USDG` : `none · owner floor ${OWNER_FLOOR}`}
                  {' · '}
                  <Link href={`/me/agents/${a.id}`}>edit mandate</Link>
                  {' · '}
                  <Link href={`/agents/${a.id}?tab=positions`}>public view</Link>
                </div>
              </div>

              {!hasWallet ? (
                <p className="m3" style={{ fontSize: 12.5, marginTop: 10 }}>
                  This agent has no chain wallet, so there is nothing to borrow against.
                </p>
              ) : (
                <>
                  <div style={{ marginTop: 12 }}>
                    <CapitalBlock id={a.id} />
                  </div>
                  <ManualCapitalPanel
                    agentId={a.id}
                    collateralSymbol={pos?.collateral.symbol ?? 'NVDA'}
                    debt={pos?.debt_usdg ?? 0}
                    walletUSDG={walletUSDG}
                    borrowHeadroom={headroom}
                    withdrawMax={withdrawMax}
                    mandateActive={mandate?.status === 'active'}
                  />
                </>
              )}
            </section>
          );
        })}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  creatorId,
  operator,
}: {
  children: React.ReactNode;
  creatorId?: string;
  operator?: boolean;
}) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current="Capital" creatorId={creatorId} operator={operator} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}
