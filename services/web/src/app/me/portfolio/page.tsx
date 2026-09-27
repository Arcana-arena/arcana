/**
 * Portfolio — every agent's book in one place.
 *
 * EVERY NUMBER SAYS WHEN IT WAS TRUE. Position values come from the market
 * snapshot each agent last acted on, and say so with its time. USDG and ETH are
 * read from the chain, cached for up to a minute, and print when they were read.
 * Nothing on this page claims to be "now" without saying which now. Relative
 * times ("4m ago") always carry the exact UTC moment in their title.
 *
 * REAL MONEY AND VIRTUAL CAPITAL ARE TOTALLED APART, because a sum of a
 * season's virtual $100,000 and a wallet's real $7 is a number describing
 * nothing.
 *
 * SUBSCRIBERS' WALLETS ARE THEIR MONEY. They are shown so a creator can see what
 * their agent's decisions hold across customers — aggregated, without wallet
 * addresses, and never added to the creator's totals.
 *
 * NO ARITHMETIC HERE. Every figure — NAV, P&L, percentages — arrives decided by
 * agent-service. The layout counts rows; it never adds money.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { addr, ago, int, num, pct, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Lbl, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Failed, StatusBox } from '@/components/ds/states';
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

type AgentBookRow = {
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
};

type Portfolio = {
  creator: { id: string; handle: string };
  agents: AgentBookRow[];
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
  const now = Date.now();

  return (
    <Shell creatorId={creator_id} handle={d.creator.handle}>
      <div className="fm-hero">
        <div>
          <div className="fm-kicker">@{d.creator.handle} · your books</div>
          <h1 style={{ marginTop: 6 }}>Portfolio</h1>
        </div>
        <div className="fm-stats">
          <div className="fm-stat">
            <div className="fm-stat-v">{int(d.agents.length)}</div>
            <div className="fm-stat-k">agents</div>
          </div>
          <div className="fm-stat">
            <div className="fm-stat-v">{int(d.subscribers.length)}</div>
            <div className="fm-stat-k">subscribed</div>
          </div>
          <div className="fm-stat" title={utc(d.as_of)}>
            <div className="fm-stat-v">{ago(d.as_of, now)}</div>
            <div className="fm-stat-k">assembled</div>
          </div>
        </div>
      </div>
      <p className="fm-note" style={{ marginTop: 12 }}>
        {d.labels.prices} {d.labels.balances}
      </p>

      <section className="pf-totals">
        <TotalCard kind="real" title="Real money" sub="agents with a wallet" t={d.totals.real} />
        <TotalCard kind="virtual" title="Virtual capital" sub="agents trading a season's capital" t={d.totals.virtual} />
      </section>
      <p className="fm-note" style={{ marginTop: 8 }}>{d.totals.note}</p>

      <div className="pf-head">
        <h2>Agents</h2>
        <span className="fm-note">one book per agent, marked at the snapshot it last acted on</span>
      </div>

      {d.agents.length === 0 ? (
        <div className="fm-empty">
          <strong style={{ color: 'var(--color-text)' }}>No agent has a book yet</strong>
          <div style={{ marginTop: 6 }}>A book starts at an agent&rsquo;s first tick in a competition. A counted zero.</div>
          <div style={{ marginTop: 14 }}>
            <Link href="/me/agents/new">Create an agent →</Link>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
          {d.agents.map((a) => (
            <AgentBook key={a.id} a={a} now={now} />
          ))}
        </div>
      )}

      <div className="pf-head">
        <h2>Subscribers&rsquo; wallets</h2>
        <Tag tone="outline">NOT YOURS · IN NO TOTAL</Tag>
      </div>
      <p className="fm-note" style={{ marginTop: -6, marginBottom: 12 }}>{d.subscribers_note}</p>
      {d.subscribers.length === 0 ? (
        <div className="fm-empty">No agent of yours has a subscriber. A counted zero.</div>
      ) : (
        <div className="pf-card">
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="r">Wallets</th>
                  <th className="r">Their NAV, total</th>
                  <th>Held across them</th>
                  <th className="r">Closed · known net</th>
                  <th className="r">Last mark</th>
                </tr>
              </thead>
              <tbody>
                {d.subscribers.map((sgrp) => (
                  <tr key={sgrp.agent_id}>
                    <td>
                      <Link href={`/me/agents/${sgrp.agent_id}`}>{sgrp.agent_name}</Link>
                    </td>
                    <td className="r mono">
                      {int(sgrp.books)}
                      {sgrp.books_with_a_mark < sgrp.books ? (
                        <div className="m3" style={{ fontSize: 10 }}>{sgrp.books_with_a_mark} marked</div>
                      ) : null}
                    </td>
                    <td className="r mono">{usd(sgrp.nav_total)}</td>
                    <td>
                      {sgrp.positions.length === 0 ? (
                        <span className="m3" style={{ fontSize: 11.5 }}>cash only</span>
                      ) : (
                        <div className="pf-chips">
                          {sgrp.positions.map((p) => (
                            <span key={p.symbol} className="pf-chip">
                              {p.symbol} <span className="m3">{num(p.quantity, 6)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="r mono">
                      {int(sgrp.closed_trades)} · <span className={tone(sgrp.net_pnl_known)}>{usd(sgrp.net_pnl_known, 4)}</span>
                    </td>
                    <td className="r mono m3" style={{ fontSize: 11 }} title={sgrp.last_marked_at ? utc(sgrp.last_marked_at) : undefined}>
                      {sgrp.last_marked_at ? ago(sgrp.last_marked_at, now) : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mono m3" style={{ fontSize: 10.5, marginTop: 24 }}>assembled {utc(d.as_of)}</div>
    </Shell>
  );
}

/** One agent's book: who it is, what it is worth, where its money sits, what it holds and what it made. */
function AgentBook({ a, now }: { a: AgentBookRow; now: number }) {
  const t = a.trade_totals;
  return (
    <section className={`pf-card pf-agent pf-${a.money}`}>
      <div className="pf-agent-hd">
        <span className="fm-glyph" aria-hidden="true">
          {Array.from(a.name.trim())[0]?.toUpperCase() ?? '?'}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Link href={`/me/agents/${a.id}`} className="fm-title">
              {a.name}
            </Link>
            <span className="mono m3" style={{ fontSize: 10.5 }}>v{a.version}</span>
            <StatusTag status={a.status} />
            <Tag tone={a.money === 'real' ? 'amber' : 'outline'}>{a.money === 'real' ? 'REAL MONEY' : 'VIRTUAL'}</Tag>
          </div>
          <div className="fm-meta">
            <span title={a.book.as_of ? utc(a.book.as_of) : undefined}>
              {a.book.as_of ? `book marked ${ago(a.book.as_of, now)}` : 'book never marked'}
            </span>
            {a.book.prices.tick_time ? (
              <span title={utc(a.book.prices.tick_time)}>· priced at snapshot {ago(a.book.prices.tick_time, now)}</span>
            ) : null}
            <span>·</span>
            <Link href={`/agents/${a.id}`}>public profile</Link>
          </div>
        </div>
        <div className="pf-nav">
          <div className="fm-stat-k">NAV</div>
          <div className="pf-nav-v">{usd(a.book.nav)}</div>
        </div>
      </div>

      <div className="pf-strip">
        <div className="pf-cell">
          <div className="fm-stat-k">cash in book</div>
          <div className="pf-cell-v">{usd(a.book.cash)}</div>
        </div>
        <div className="pf-cell">
          <div className="fm-stat-k">open positions</div>
          <div className="pf-cell-v">{int(a.book.open.length)}</div>
        </div>
        <div className="pf-cell" title={t.note}>
          <div className="fm-stat-k">closed · net</div>
          <div className="pf-cell-v">
            {int(t.closed)} · <span className={tone(t.net_pnl)}>{usd(t.net_pnl, 4)}</span>
          </div>
        </div>
        <div className="pf-cell" title={t.note}>
          <div className="fm-stat-k">gas paid</div>
          <div className="pf-cell-v">{usd(t.gas_usd, 4)}</div>
        </div>
      </div>

      {a.wallet || a.chain ? (
        <div className="pf-wallet">
          <span className="fm-stat-k">wallet</span>
          {a.wallet ? (
            <span className="mono" title={a.wallet.address}>
              {addr(a.wallet.address)}
            </span>
          ) : null}
          {a.chain ? (
            <>
              <span className="mono">
                USDG{' '}
                {a.chain.cash.available ? (
                  trim(a.chain.cash.amount)
                ) : (
                  <span className="m3" title={a.chain.cash.reason ?? undefined}>unread</span>
                )}
              </span>
              <span className="mono">
                ETH{' '}
                {a.chain.gas.available ? (
                  trim(a.chain.gas.amount)
                ) : (
                  <span className="m3" title={a.chain.gas.reason ?? undefined}>unread</span>
                )}
              </span>
              <span className="mono m3" title={utc(a.chain.read_at)}>
                read {ago(a.chain.read_at, now)}
                {a.chain.cached ? ' (cached)' : ''}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <p className="fm-note pf-pad" style={{ marginTop: 10 }}>{a.chain_note}</p>

      <div className="pf-pad" style={{ marginTop: 14 }}>
        <Lbl>Holding</Lbl>
        {a.book.open.length === 0 ? (
          <div className="pf-quiet">{a.book.cash === null ? 'No book yet.' : `Cash only · ${usd(a.book.cash)}`}</div>
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
                    <td className="mono" style={{ fontWeight: 600 }}>{p.symbol}</td>
                    <td className="r mono">{num(p.quantity, 8)}</td>
                    <td className="r mono" title={p.entry_note ?? undefined}>
                      {p.entry_known ? num(p.entry_price, 4) : <span className="m3">unknown</span>}
                    </td>
                    <td className="r mono" title={p.price_note}>{p.price === null ? '—' : num(p.price, 4)}</td>
                    <td className="r mono">{usd(p.value)}</td>
                    <td className={`r mono ${tone(p.pnl)}`} title={p.pnl === null ? p.entry_note ?? p.price_note : undefined}>
                      {p.pnl === null ? <span className="m3">—</span> : usd(p.pnl, 4)}
                      {p.pnl !== null && p.pnl_pct !== null ? <div style={{ fontSize: 10 }}>{pct(p.pnl_pct)}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="pf-pad" style={{ marginTop: 18, paddingBottom: 18 }}>
        <Lbl>Closed positions · what each made</Lbl>
        {a.trades.length === 0 ? (
          <div className="pf-quiet">No position opened and closed on record.</div>
        ) : (
          <>
            <TradesTable trades={a.trades} limit={5} />
            {a.trades.length > 5 ? (
              <div style={{ fontSize: 11.5, marginTop: 8 }}>
                <Link href={`/agents/${a.id}?tab=positions`}>all {a.trades.length} closed positions →</Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function TotalCard({ kind, title, sub, t }: { kind: 'real' | 'virtual'; title: string; sub: string; t: Totals }) {
  return (
    <div className={`pf-card pf-total pf-${kind}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <span className="fm-kicker" style={{ color: kind === 'real' ? 'var(--amber)' : 'var(--ink-2)' }}>{title}</span>
        <span className="mono m3" style={{ fontSize: 10.5 }}>
          {int(t.agents)} {t.agents === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <div className="pf-total-v">{t.agents === 0 ? '—' : usd(t.nav)}</div>
      <div className="m3" style={{ fontSize: 11 }}>{sub}</div>
      <div className="pf-total-ft">
        <span>
          closed net <span className={tone(t.net_pnl)}>{usd(t.net_pnl, 4)}</span>
        </span>
        <span>
          realized <span className={tone(t.realized_pnl)}>{usd(t.realized_pnl, 4)}</span>
        </span>
        <span>gas {usd(t.gas_usd, 4)}</span>
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
