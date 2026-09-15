import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AgentPositionsService } from '../agents/positions.service';
import { AgentWalletViewService } from '../agents/wallet-view.service';

/**
 * One creator's portfolio: every agent's book in one place.
 *
 * ONE DEFINITION OF A POSITION. Each agent's holdings, cost basis, value and
 * finished trades come from AgentPositionsService — the same code behind the
 * public Positions tab — so this page cannot disagree with that one.
 *
 * EVERY NUMBER SAYS WHEN IT WAS TRUE:
 *   prices     the market snapshot each agent last acted on, named with its
 *              time. Not a live quote, and labelled so.
 *   balances   USDG and ETH read from the chain, cached for a minute, with
 *              the moment they were read. A figure that claims "now" and is
 *              two minutes old is a small version of the lie this project
 *              keeps removing.
 *
 * REAL MONEY AND VIRTUAL CAPITAL ARE NEVER ADDED TOGETHER. An agent with a
 * wallet trades real funds; one without trades a season's virtual capital.
 * A total of $100,007 made of $100,000 that does not exist and $7 that does
 * would be the most misleading number on the page.
 *
 * SUBSCRIBERS' WALLETS ARE SHOWN, SEPARATELY, AND NEVER SUMMED IN. Those
 * positions belong to the buyers, not to the creator. They are aggregated per
 * agent without wallet addresses: the creator can see what their agent's
 * decisions hold across customers, not who bought what.
 */

const BALANCE_CACHE_MS = 60_000;
const BALANCE_TIMEOUT_MS = 4_000;

type ChainReading = {
  read_at: string;
  cached: boolean;
  cash: { available: boolean; amount: string | null; reason: string | null };
  gas: { available: boolean; amount: string | null; reason: string | null };
};

@Injectable()
export class CreatorPortfolioService {
  private readonly balanceCache = new Map<string, { at: number; value: Omit<ChainReading, 'cached'> }>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly positions: AgentPositionsService,
    private readonly wallets: AgentWalletViewService,
  ) {}

  private async chainFor(agentId: string): Promise<ChainReading> {
    const hit = this.balanceCache.get(agentId);
    if (hit && Date.now() - hit.at < BALANCE_CACHE_MS) return { ...hit.value, cached: true };
    let value: Omit<ChainReading, 'cached'>;
    try {
      const b = (await Promise.race([
        this.wallets.balances(agentId),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${BALANCE_TIMEOUT_MS / 1000}s`)), BALANCE_TIMEOUT_MS)),
      ])) as Record<string, any>;
      value = {
        read_at: b?.as_of ?? new Date().toISOString(),
        cash: { available: b?.token?.available === true, amount: b?.token?.available ? b.token.amount : null, reason: b?.token?.reason ?? null },
        gas: { available: b?.native?.available === true, amount: b?.native?.available ? b.native.amount : null, reason: b?.native?.reason ?? null },
      };
    } catch (e) {
      const reason = `the chain could not be read (${e instanceof Error ? e.message : String(e)}); unread, not zero`;
      value = {
        read_at: new Date().toISOString(),
        cash: { available: false, amount: null, reason },
        gas: { available: false, amount: null, reason },
      };
    }
    this.balanceCache.set(agentId, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  async forCreator(creatorId: string) {
    const creator = await this.db.query(`SELECT id::text, handle FROM creators WHERE id = $1`, [creatorId]);
    if (creator.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);

    const agents: Array<Record<string, any>> = await this.db.query(
      `SELECT a.id::text, a.name, a.version, a.status, a.visibility, w.address AS wallet_address, w.key_custody
         FROM agents a LEFT JOIN agent_wallets w ON w.agent_id = a.id
        WHERE a.creator_id = $1
          AND EXISTS (SELECT 1 FROM portfolios p WHERE p.agent_id = a.id)
        ORDER BY (a.status = 'active') DESC, a.created_at DESC`,
      [creatorId],
    );

    const books = await Promise.all(
      agents.map(async (a) => {
        const p = (await this.positions.forAgent(a.id)) as Record<string, any>;
        const realMoney = !!a.wallet_address;
        const chain = realMoney && (a.status === 'active' || a.status === 'paused') ? await this.chainFor(a.id) : null;
        return {
          id: a.id,
          name: a.name,
          version: Number(a.version),
          status: a.status,
          visibility: a.visibility,
          money: realMoney ? ('real' as const) : ('virtual' as const),
          wallet: realMoney ? { address: a.wallet_address, key_custody: a.key_custody } : null,
          book: {
            as_of: p.as_of,
            nav: p.nav,
            cash: p.cash,
            prices: p.prices,
            open: p.open,
            note: p.note,
          },
          chain,
          chain_note: realMoney
            ? chain
              ? 'USDG and ETH as the chain reported them at read_at (cached for up to a minute). Stock tokens are ' +
                'from the book above, which is the chain reading at the last tick.'
              : 'Not read: a retired or draft agent is not trading.'
            : 'Virtual capital: nothing is on chain for this agent.',
          trades: p.trades,
          trade_totals: p.trade_totals,
        };
      }),
    );

    const totalsFor = (money: 'real' | 'virtual') => {
      const set = books.filter((b) => b.money === money && b.book.nav !== null);
      const sum = (f: (b: (typeof books)[number]) => number | null) =>
        Number(set.reduce((s, b) => s + (f(b) ?? 0), 0).toFixed(6));
      return {
        agents: set.length,
        nav: sum((b) => b.book.nav),
        realized_pnl: sum((b) => b.trade_totals?.realized_pnl ?? 0),
        gas_usd: sum((b) => b.trade_totals?.gas_usd ?? 0),
        net_pnl: sum((b) => b.trade_totals?.net_pnl ?? 0),
      };
    };

    // SUBSCRIBERS: per agent, aggregated, never added in.
    const subRows: Array<Record<string, any>> = await this.db.query(
      `SELECT a.id::text AS agent_id, a.name AS agent_name, s.id::text AS subscription_id, s.status,
              ls.holdings, ls.nav::float8 AS nav, ls.cash::float8 AS cash, ls.ts
         FROM subscriptions s
         JOIN agents a ON a.id = s.agent_id AND a.creator_id = $1
         LEFT JOIN LATERAL (
           SELECT holdings, nav, cash, ts FROM subscription_snapshots ss
            WHERE ss.subscription_id = s.id ORDER BY ts DESC LIMIT 1) ls ON true`,
      [creatorId],
    );
    const subTrades: Array<Record<string, any>> = await this.db.query(
      `SELECT pe.agent_id::text AS agent_id, count(*)::int AS closed,
              count(*) FILTER (WHERE pe.net_pnl IS NOT NULL)::int AS with_known_result,
              coalesce(sum(pe.net_pnl), 0)::float8 AS net_pnl
         FROM position_episodes pe
         JOIN agents a ON a.id = pe.agent_id AND a.creator_id = $1
        WHERE pe.book = 'subscription' AND pe.closed_at IS NOT NULL
        GROUP BY pe.agent_id`,
      [creatorId],
    );
    const subTradesBy = new Map(subTrades.map((t) => [t.agent_id, t]));
    const byAgent = new Map<string, any>();
    for (const r of subRows) {
      const g = byAgent.get(r.agent_id) ?? {
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        books: 0,
        books_with_a_mark: 0,
        nav_total: 0,
        positions: new Map<string, number>(),
        last_marked_at: null as string | null,
      };
      g.books++;
      if (r.ts) {
        g.books_with_a_mark++;
        g.nav_total += Number(r.nav ?? 0);
        const at = new Date(r.ts).toISOString();
        if (!g.last_marked_at || at > g.last_marked_at) g.last_marked_at = at;
        for (const [sym, q] of Object.entries((r.holdings ?? {}) as Record<string, number>)) {
          if (Number(q) >= 1e-8) g.positions.set(sym, (g.positions.get(sym) ?? 0) + Number(q));
        }
      }
      byAgent.set(r.agent_id, g);
    }
    const subscribers = [...byAgent.values()].map((g) => {
      const t = subTradesBy.get(g.agent_id);
      return {
        agent_id: g.agent_id,
        agent_name: g.agent_name,
        books: g.books,
        books_with_a_mark: g.books_with_a_mark,
        nav_total: Number(g.nav_total.toFixed(2)),
        last_marked_at: g.last_marked_at,
        positions: [...g.positions.entries()].map(([symbol, qty]) => ({ symbol, quantity: Number(qty.toFixed(8)) })),
        closed_trades: t ? t.closed : 0,
        net_pnl_known: t ? Number(Number(t.net_pnl).toFixed(6)) : 0,
      };
    });

    return {
      creator: { id: creator[0].id, handle: creator[0].handle },
      agents: books,
      totals: {
        real: totalsFor('real'),
        virtual: totalsFor('virtual'),
        note:
          'Your agents’ own books only. Real money (agents with a wallet) and virtual capital (agents without one) ' +
          'are totalled separately and never added together. Subscribers’ wallets are not included.',
      },
      subscribers,
      subscribers_note:
        'Positions in your subscribers’ own wallets, aggregated per agent. They are the buyers’ money, not yours, ' +
        'and are not part of any total above. Wallets are not identified. Each book is as its last mark recorded it.',
      labels: {
        prices: 'Position values use the market snapshot each agent last acted on, named with its time — not live quotes.',
        balances: `USDG and ETH are read from the chain and cached for up to ${BALANCE_CACHE_MS / 1000} seconds; read_at says when.`,
      },
      as_of: new Date().toISOString(),
    };
  }
}
