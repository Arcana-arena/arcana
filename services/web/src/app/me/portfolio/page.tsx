/**
 * Portfolio — every agent's book in one place.
 *
 * EVERY NUMBER SAYS WHEN IT WAS TRUE. Position values come from the market
 * snapshot each agent last acted on, and say so with its time. USDG and ETH are
 * read from the chain, cached for up to a minute, and print when they were read.
 * Nothing on this page claims to be "now" without saying which now.
 *
 * REAL MONEY AND VIRTUAL CAPITAL ARE TOTALLED APART, because a sum of a
 * season's virtual $100,000 and a wallet's real $7 is a number describing
 * nothing.
 *
 * SUBSCRIBERS' WALLETS ARE THEIR MONEY. They are shown so a creator can see what
 * their agent's decisions hold across customers — aggregated, without wallet
 * addresses, and never added to the creator's totals.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { int, num, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../CreatorNav';
import { TradesTable, type Trade } from '../../agents/[id]/tabs/Positions';

export const dynamic = 'force-dynamic';

type Open = {
  symbol: string;
  quantity: number | null;
  entry_price: number | null;
  entry_known: boolean;
  entry_source?: 'fills' | 'guard' | null;
  entry_note: string | null;
  price: number | null;
  price_note: string;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
};

type Totals = { agents: number; nav: number; realized_pnl: number; gas_usd: number; net_pnl: number };

type Portfolio = {
  creator: { id: string; handle: string };
  agents: Array<{
    id: string;
    name: string;
    version: number;
    status: string;
    visibility: string;
    money: 'real' | 'virtual';
    wallet: { address: string; key_custody: string | null } | null;
    book: {
      as_of: string | null;
      nav: number | null;
      cash: number | null;
      prices: { snapshot_ref: string | null; tick_time: string | null; available: boolean; reason: string | null };
      open: Open[];
      note: string | null;
    };
    chain: null | {
      read_at: string;
      cached: boolean;
      cash: { available: boolean; amount: string | null; reason: string | null };
      gas: { available: boolean; amount: string | null; reason: string | null };
    };
    chain_note: string;
    trades: Trade[];
    trade_totals: { closed: number; with_known_result: number; realized_pnl: number | null; gas_usd: number | null; net_pnl: number | null; winners: number; note: string };
  }>;
  totals: { real: Totals; virtual: Totals; note: string };
  subscribers: Array<{
    agent_id: string;
    agent_name: string;
    books: number;
    books_with_a_mark: number;
    nav_total: number;
    last_marked_at: string | null;
    positions: Array<{ symbol: string; quantity: number }>;
    closed_trades: number;
    net_pnl_known: number;
  }>;
  subscribers_note: string;
  labels: { prices: string; balances: string };
  as_of: string;
};

const usd = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(dp)}`;
const trim = (v: string | null) => (v && v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? '' : v > 0 ? 'up' : v < 0 ? 'dn' : '');

export default async function PortfolioPage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fportfolio');
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
  if (!creator_id) {
    return (
      <Shell>
        <h1>Portfolio</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            <strong>This wallet has no creator profile yet</strong>, so it has no agents to hold anything.{' '}
            <Link href="/me">Set up your creator profile</Link> first.
          </Callout>
        </div>
      </Shell>
    );
  }

  const r = await authed<Portfolio>(`/v1/creators/${creator_id}/portfolio`);
  if (!r.ok) {
    return (
      <Shell creatorId={creator_id}>
        <h1>Portfolio</h1>
        <div style={{ marginTop: 16 }}>
          <Failed what="Your portfolio" error={{ ok: false, status: r.status, reason: r.reason, code: r.code }} />
        </div>
      </Shell>
    );
  }
  const d = r.data;

  return (
    <Shell creatorId={creator_id} handle={d.creator.handle}>
      <h1>Portfolio</h1>
      <div className="m3" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, maxWidth: 820 }}>
        {d.labels.prices} {d.labels.balances}
      </div>

      <section className="two-col" style={{ marginTop: 20 }}>
        <TotalBox title="Real money" sub="agents with a wallet" t={d.totals.real} />
        <TotalBox title="Virtual capital" sub="agents trading a season's capital" t={d.totals.virtual} />
      </section>
      <div className="m3" style={{ fontSize: 10.5, marginTop: 8 }}>{d.totals.note}</div>

      {d.agents.length === 0 ? (
        <div style={{ marginTop: 22 }}>
          <Empty title="No agent has a book yet">
            A book starts at an agent&rsquo;s first tick in a competition. A counted zero.
          </Empty>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14, marginTop: 22 }}>
          {d.agents.map((a) => (
            <section key={a.id} className="box">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Link href={`/me/agents/${a.id}`} style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 600 }}>
                  {a.name}
                </Link>
                <span className="mono m3" style={{ fontSize: 10 }}>v{a.version}</span>
                <StatusTag status={a.status} />
                <Tag tone={a.money === 'real' ? 'amber' : 'outline'}>{a.money === 'real' ? 'REAL MONEY' : 'VIRTUAL'}</Tag>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 13 }}>
                  NAV {a.book.nav === null ? '—' : usd(a.book.nav)}
                </span>
              </div>

              {a.chain ? (
                <div className="mono m2" style={{ fontSize: 11.5, marginTop: 6 }}>
                  on chain: USDG {a.chain.cash.available ? trim(a.chain.cash.amount) : <span className="m3">unread</span>} · ETH{' '}
                  {a.chain.gas.available ? trim(a.chain.gas.amount) : <span className="m3">unread</span>} ·{' '}
                  <span className="m3">
                    read {utc(a.chain.read_at)}
                    {a.chain.cached ? ' (cached)' : ''}
                  </span>
                </div>
              ) : null}
              <div className="m3" style={{ fontSize: 10.5, marginTop: 2 }}>{a.chain_note}</div>

              <div style={{ marginTop: 12 }}>
                <Lbl>
                  Holding · book {a.book.as_of ? utc(a.book.as_of) : 'never marked'}
                  {a.book.prices.tick_time ? ` · priced at snapshot ${utc(a.book.prices.tick_time)}` : ''}
                </Lbl>
                {a.book.open.length === 0 ? (
                  <div className="m2" style={{ fontSize: 12, marginTop: 6 }}>
                    {a.book.cash === null ? 'no book yet' : `cash only · ${usd(a.book.cash)}`}
                  </div>
                ) : (
                  <div className="scroll-x">
                    <table className="table" style={{ marginTop: 6 }}>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th className="r">Quantity</th>
                          <th className="r">Avg cost</th>
                          <th className="r">Snapshot price</th>
                          <th className="r">Value</th>
                          <th className="r">Unrealized</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.book.open.map((p) => (
                          <tr key={p.symbol}>
                            <td className="mono">{p.symbol}</td>
                            <td className="r mono">{num(p.quantity, 8)}</td>
                            <td className="r mono" title={p.entry_note ?? undefined}>
                              {p.entry_known ? num(p.entry_price, 4) : <span className="m3">unknown</span>}
                            </td>
                            <td className="r mono" title={p.price_note}>{p.price === null ? '—' : num(p.price, 4)}</td>
                            <td className="r mono">{usd(p.value)}</td>
                            <td className={`r mono ${tone(p.pnl)}`} title={p.pnl === null ? p.entry_note ?? p.price_note : undefined}>
                              {p.pnl === null ? <span className="m3">—</span> : usd(p.pnl, 4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {a.book.cash !== null && a.book.open.length > 0 ? (
                  <div className="mono m3" style={{ fontSize: 10.5, marginTop: 4 }}>cash in book {usd(a.book.cash)}</div>
                ) : null}
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <Lbl>Closed positions · what each made</Lbl>
                  <span className="mono m2" style={{ fontSize: 11 }} title={a.trade_totals.note}>
                    {int(a.trade_totals.closed)} closed · net{' '}
                    <span className={tone(a.trade_totals.net_pnl)}>{usd(a.trade_totals.net_pnl, 4)}</span> after{' '}
                    {usd(a.trade_totals.gas_usd, 4)} gas
                  </span>
                </div>
                {a.trades.length === 0 ? (
                  <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>No position opened and closed on record.</div>
                ) : (
                  <>
                    <TradesTable trades={a.trades} limit={5} />
                    {a.trades.length > 5 ? (
                      <div style={{ fontSize: 11, marginTop: 4 }}>
                        <Link href={`/agents/${a.id}?tab=positions`}>all {a.trades.length} closed positions →</Link>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <section style={{ marginTop: 28 }}>
        <Key>Subscribers&rsquo; wallets · not yours, not in any total</Key>
        <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45, maxWidth: 820 }}>{d.subscribers_note}</div>
        {d.subscribers.length === 0 ? (
          <div className="m2" style={{ fontSize: 12, marginTop: 8 }}>No agent of yours has a subscriber. A counted zero.</div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="r">Wallets</th>
                  <th className="r">Their NAV, total</th>
                  <th>Held across them</th>
                  <th className="r">Closed · known net</th>
                  <th>Last mark</th>
                </tr>
              </thead>
              <tbody>
                {d.subscribers.map((sgrp) => (
                  <tr key={sgrp.agent_id}>
                    <td>{sgrp.agent_name}</td>
                    <td className="r mono">
                      {int(sgrp.books)}
                      {sgrp.books_with_a_mark < sgrp.books ? <div className="m3" style={{ fontSize: 10 }}>{sgrp.books_with_a_mark} marked</div> : null}
                    </td>
                    <td className="r mono">{usd(sgrp.nav_total)}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {sgrp.positions.length === 0 ? <span className="m3">cash only</span> : sgrp.positions.map((p) => `${p.symbol} ${num(p.quantity, 6)}`).join(' · ')}
                    </td>
                    <td className="r mono">
                      {int(sgrp.closed_trades)} · <span className={tone(sgrp.net_pnl_known)}>{usd(sgrp.net_pnl_known, 4)}</span>
                    </td>
                    <td className="mono m3" style={{ fontSize: 11 }}>{sgrp.last_marked_at ? utc(sgrp.last_marked_at) : 'never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mono m3" style={{ fontSize: 10.5, marginTop: 24 }}>assembled {utc(d.as_of)}</div>
    </Shell>
  );
}

function TotalBox({ title, sub, t }: { title: string; sub: string; t: Totals }) {
  return (
    <div className="box">
      <Key>{title}</Key>
      <div className="m3" style={{ fontSize: 10.5 }}>{sub} · {int(t.agents)}</div>
      <div className="mono" style={{ fontSize: 22, marginTop: 6 }}>{t.agents === 0 ? '—' : usd(t.nav)}</div>
      <div className="mono m2" style={{ fontSize: 11, marginTop: 2 }}>
        closed positions net <span className={tone(t.net_pnl)}>{usd(t.net_pnl, 4)}</span> · gas {usd(t.gas_usd, 4)}
      </div>
    </div>
  );
}

function Shell({ children, creatorId, handle }: { children: React.ReactNode; creatorId?: string; handle?: string }) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current="Portfolio" handle={handle} creatorId={creatorId} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}
