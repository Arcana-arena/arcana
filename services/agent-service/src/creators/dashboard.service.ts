import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MAX_ACTIVE_AGENTS_PER_CREATOR } from '../agents/agents.service';
import { AgentWalletViewService } from '../agents/wallet-view.service';
import { MIN_DECISIONS } from '../common/ranking';
import { creatorReputation } from '../reputation/creator-reputation';

/**
 * One creator's own dashboard, assembled once.
 *
 * WHAT MAKES THIS DIFFERENT FROM /v1/creators/:id/agents. That endpoint is
 * public and returns identity plus a score. A dashboard answers the question an
 * owner opens it with — "what are my agents doing right now" — so each agent
 * carries what it holds, what it last decided, and whether anything needs them.
 *
 * THE SLOT CAP IS PUBLISHED HERE, and it had to come from somewhere. It is a
 * constant in this service, and the /me page carried a comment saying it could
 * not print "n of 3" because no response contained the 3. So the response
 * contains it, with the note that it counts ACTIVE agents: a creator with nine
 * retired agents and two live ones has a slot free, and a cap on the total
 * would charge them for their own history.
 *
 * "NEEDS ATTENTION" IS DERIVED FROM THE RECORD, NEVER FROM A GUESS. Each item
 * names the row it came from.
 *
 * LOW GAS IS HERE NOW, AND IT IS THE WALLET PAGE'S OWN MEASUREMENT. It used to
 * be deliberately absent because this service read no chain balances. It now
 * asks AgentWalletViewService — the same code the wallet tab uses — so there is
 * one definition of "low": fewer than ten transactions left at the median gas of
 * the agent's OWN fills. An agent with too few fills to measure is reported as
 * unknown, never as fine. Balances are cached for a minute so reloading the
 * dashboard does not hammer the chain reader, and a read that times out is
 * reported as unread rather than as a full tank.
 */

export type Attention = {
  agent_id: string;
  agent_name: string | null;
  kind: 'paused_by_meter' | 'unguarded_position' | 'guard_held_back' | 'no_wallet' | 'gas_low' | 'unranked' | 'quiet';
  detail: string;
  since: string | null;
};

type GasState = {
  read: boolean;
  known: boolean;
  low: boolean | null;
  transactions_affordable: number | null;
  native_amount: string | null;
  note: string | null;
};

const GAS_CACHE_MS = 60_000;
const GAS_TIMEOUT_MS = 4_000;

@Injectable()
export class CreatorDashboardService {
  private readonly quietMinutes: number;
  private readonly gasCache = new Map<string, { at: number; value: GasState }>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly wallets: AgentWalletViewService,
    config: ConfigService,
  ) {
    // The same threshold the status page uses, and configurable for the same
    // reason: a cadence this deployment does not run yet would make every agent
    // look stalled.
    const q = Number(config.get<string>('AGENT_QUIET_MINUTES') ?? '180');
    this.quietMinutes = Number.isFinite(q) && q > 0 ? q : 180;
  }

  /** The wallet tab's own gas reading, cached briefly, never defaulted. */
  private async gasFor(agentId: string): Promise<GasState> {
    const hit = this.gasCache.get(agentId);
    if (hit && Date.now() - hit.at < GAS_CACHE_MS) return hit.value;

    let value: GasState;
    try {
      const b = (await Promise.race([
        this.wallets.balances(agentId),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${GAS_TIMEOUT_MS / 1000}s`)), GAS_TIMEOUT_MS)),
      ])) as Record<string, any>;
      const gas = b?.gas ?? null;
      value = {
        read: b?.native?.available === true,
        known: gas?.known === true,
        low: gas?.known === true ? gas.low === true : null,
        transactions_affordable: gas?.transactions_affordable ?? null,
        native_amount: b?.native?.available ? (b.native.amount ?? null) : null,
        note: gas?.known ? (gas.note ?? null) : (gas?.reason ?? b?.native?.reason ?? b?.note ?? null),
      };
    } catch (e) {
      value = {
        read: false,
        known: false,
        low: null,
        transactions_affordable: null,
        native_amount: null,
        note: `The gas balance could not be read (${e instanceof Error ? e.message : String(e)}). Unread, not full.`,
      };
    }
    this.gasCache.set(agentId, { at: Date.now(), value });
    return value;
  }

  async forCreator(creatorId: string) {
    const creator = await this.db.query(
      `SELECT id::text, handle, wallet_address, status, created_at
         FROM creators WHERE id = $1`,
      [creatorId],
    );
    if (creator.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);
    const c = creator[0];
    // Derived from sealed scores; creators.reputation_score is never read.
    const rep = await creatorReputation(this.db, creatorId);

    const agents: Array<Record<string, any>> = await this.db.query(
      `
      WITH latest_score AS (
        SELECT DISTINCT ON (agent_id) agent_id, arcana_score::float8 AS score, ts
          FROM score_snapshots ORDER BY agent_id, ts DESC
      ),
      latest_nav AS (
        SELECT DISTINCT ON (p.agent_id) p.agent_id, ps.nav::float8 AS nav, ps.cash::float8 AS cash, ps.ts, ps.holdings
          FROM portfolio_snapshots ps
          JOIN portfolios p ON p.id = ps.portfolio_id
         ORDER BY p.agent_id, ps.ts DESC
      ),
      counted AS (
        SELECT agent_id, count(*)::int AS decisions, max(ts) AS last_decision
          FROM decisions_counted GROUP BY agent_id
      ),
      last_decided AS (
        SELECT DISTINCT ON (agent_id) agent_id, action, symbol, decider, reason_code, ts
          FROM decisions_counted
         WHERE agent_id IN (SELECT id FROM agents WHERE creator_id = $1)
         ORDER BY agent_id, ts DESC, id DESC
      ),
      listed AS (
        SELECT l.agent_id, l.id::text AS listing_id, l.price_usd::float8 AS price_usd, l.active,
               (SELECT count(*) FILTER (WHERE s.status = 'active') FROM subscriptions s WHERE s.listing_id = l.id)::int AS subs_active,
               (SELECT count(*) FILTER (WHERE s.status = 'grace')  FROM subscriptions s WHERE s.listing_id = l.id)::int AS subs_grace
          FROM marketplace_listings l
      )
      SELECT a.id::text, a.name, a.version, a.status, a.strategy_type, a.asset_universe,
             a.created_at, a.parent_agent_id::text, a.mandate, a.risk_profile,
             s.score, s.ts AS score_at,
             n.nav, n.cash, n.ts AS nav_at, n.holdings,
             coalesce(d.decisions, 0) AS decisions, d.last_decision,
             ld.action AS last_action, ld.symbol AS last_symbol, ld.decider AS last_decider,
             ld.reason_code AS last_decision_reason,
             li.listing_id, li.price_usd, li.active AS listing_active,
             coalesce(li.subs_active, 0) AS subs_active,
             coalesce(li.subs_grace, 0) AS subs_grace,
             w.address AS wallet_address, w.key_custody
        FROM agents a
        LEFT JOIN latest_score s ON s.agent_id = a.id
        LEFT JOIN latest_nav   n ON n.agent_id = a.id
        LEFT JOIN counted      d ON d.agent_id = a.id
        LEFT JOIN last_decided ld ON ld.agent_id = a.id
        LEFT JOIN listed      li ON li.agent_id = a.id
        LEFT JOIN agent_wallets w ON w.agent_id = a.id
       WHERE a.creator_id = $1
       ORDER BY (a.status = 'active') DESC, a.created_at DESC`,
      [creatorId],
    );

    // THE PROTECTIVE STATE OF EVERY AGENT AT ONCE. One query rather than one
    // per row: an owner with three agents should not pay three round trips to
    // be told a stop is held back, and the item that matters most is the one
    // that would be missed if a row failed to load.
    const guards: Array<Record<string, any>> = await this.db.query(
      `SELECT agent_id::text, status, symbol, last_refusal_at, last_refusal_reason, min_acceptable_pct::float8 AS min_acceptable_pct
         FROM position_guards
        WHERE subscription_id IS NULL
          AND agent_id IN (SELECT id FROM agents WHERE creator_id = $1)
          AND status IN ('armed', 'refused')`,
      [creatorId],
    );

    // The most recent refusal per agent, whatever reason the engine gave.
    const paused: Array<Record<string, any>> = await this.db.query(
      `SELECT DISTINCT ON (agent_id) agent_id::text, reason_code, rationale, ts
         FROM decisions_counted
        WHERE agent_id IN (SELECT id FROM agents WHERE creator_id = $1)
          AND reason_code IS NOT NULL AND reason_code <> ''
        ORDER BY agent_id, ts DESC`,
      [creatorId],
    );
    const pausedBy = new Map(paused.map((p) => [p.agent_id, p]));

    // GAS ONLY WHERE IT CAN MATTER: an agent with a wallet that is live or
    // paused. A retired agent decides nothing; a draft has not started.
    const gasEntries = await Promise.all(
      agents
        .filter((a) => a.wallet_address && (a.status === 'active' || a.status === 'paused'))
        .map(async (a) => [a.id, await this.gasFor(a.id)] as const),
    );
    const gasBy = new Map<string, GasState>(gasEntries);

    const round = (v: unknown, dp: number) =>
      v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp));

    const attention: Attention[] = [];
    const items = agents.map((a) => {
      const agentGuards = guards.filter((g) => g.agent_id === a.id);
      const heldBack = agentGuards.filter((g) => g.status === 'armed' && g.last_refusal_at);
      const refused = agentGuards.filter((g) => g.status === 'refused');
      const lastReason = pausedBy.get(a.id) ?? null;
      const gas = gasBy.get(a.id) ?? null;
      const quietMins =
        a.last_decision ? Math.floor((Date.now() - new Date(a.last_decision).getTime()) / 60000) : null;

      if (a.status === 'active' || a.status === 'paused') {
        if (gas?.low === true) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'gas_low',
            detail:
              `The wallet's gas covers about ${gas.transactions_affordable} more transactions at the median cost of ` +
              "this agent's own fills. At zero it cannot sell, and an armed protective stop cannot fire either.",
            since: null,
          });
        }
      }

      if (a.status === 'active') {
        if (lastReason?.reason_code === 'cost_budget_exceeded') {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'paused_by_meter',
            // The engine's own sentence, not a summary of it. It carries the
            // spend, the budget and the capital it was measured against.
            detail: lastReason.rationale ?? 'the cost meter paused this agent and recorded no detail',
            since: lastReason.ts ? new Date(lastReason.ts).toISOString() : null,
          });
        }
        for (const g of heldBack) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'guard_held_back',
            detail:
              `${g.symbol}: a protective level is armed, crossed, and the exit was not taken — ` +
              `${g.last_refusal_reason ?? 'no reason recorded'}. An armed level that is held back is worse ` +
              'than no level, because its owner believes the position is covered.',
            since: g.last_refusal_at ? new Date(g.last_refusal_at).toISOString() : null,
          });
        }
        for (const g of refused) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'unguarded_position',
            detail:
              `${g.symbol}: a protective level was asked for and refused. Nothing is watching this position ` +
              (g.min_acceptable_pct !== null
                ? `between ticks; the smallest level this pool accepts is ${g.min_acceptable_pct} ` +
                  `(= ${(Number(g.min_acceptable_pct) * 100).toFixed(4)}%).`
                : 'between ticks.'),
            since: null,
          });
        }
        if (!a.wallet_address) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'no_wallet',
            detail:
              'This agent has no trading wallet yet, so nothing it decides can settle. It is active and ' +
              'nothing is happening on chain.',
            since: null,
          });
        }
        if (quietMins !== null && quietMins > this.quietMinutes) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'quiet',
            detail:
              `No decision has been recorded for ${quietMins} minutes. That is longer than this ` +
              `deployment's ${this.quietMinutes}-minute threshold, and it may mean nothing is ticking for it.`,
            since: a.last_decision ? new Date(a.last_decision).toISOString() : null,
          });
        }
        if (Number(a.decisions) < MIN_DECISIONS) {
          attention.push({
            agent_id: a.id,
            agent_name: a.name,
            kind: 'unranked',
            detail:
              `${a.decisions} of the ${MIN_DECISIONS} decisions needed to be ranked. This is not a low score — ` +
              'no score is published at all until the threshold is met.',
            since: null,
          });
        }
      }

      // WHAT IT HOLDS, from the snapshot the NAV came from — so the positions
      // and the NAV beside them always describe the same moment. Zero
      // quantities are dropped: a residue of nothing is not a position.
      const holdings =
        a.holdings && typeof a.holdings === 'object' && !Array.isArray(a.holdings)
          ? Object.entries(a.holdings as Record<string, unknown>)
              .map(([symbol, qty]) => ({ symbol, qty: Number(qty) }))
              .filter((h) => Number.isFinite(h.qty) && h.qty !== 0)
              .sort((x, y) => x.symbol.localeCompare(y.symbol))
          : null;

      return {
        id: a.id,
        name: a.name,
        version: a.version,
        status: a.status,
        strategy_type: a.strategy_type,
        asset_universe: a.asset_universe,
        created_at: a.created_at ? new Date(a.created_at).toISOString() : null,
        parent_agent_id: a.parent_agent_id,
        mandate: a.mandate ?? null,
        risk_profile: a.risk_profile ?? null,
        // The LATEST SNAPSHOT score, which is not the leaderboard's published
        // one: the board withholds below the threshold and this does not. Both
        // are returned so a dashboard can show its owner the number the engine
        // last wrote AND whether anyone else can see it.
        latest_score: round(a.score, 1),
        latest_score_at: a.score_at ? new Date(a.score_at).toISOString() : null,
        ranked: Number(a.decisions) >= MIN_DECISIONS,
        decisions: Number(a.decisions),
        decisions_needed_to_rank: MIN_DECISIONS,
        last_decision_at: a.last_decision ? new Date(a.last_decision).toISOString() : null,
        last_decision: a.last_action
          ? {
              action: a.last_action,
              symbol: a.last_symbol ?? null,
              decider: a.last_decider ?? null,
              reason_code: a.last_decision_reason ?? null,
            }
          : null,
        nav: round(a.nav, 2),
        cash: round(a.cash, 2),
        nav_at: a.nav_at ? new Date(a.nav_at).toISOString() : null,
        // null = no snapshot yet (nothing is known); [] = a snapshot holding only cash.
        positions: a.nav_at ? (holdings ?? []) : null,
        listing: a.listing_id
          ? {
              id: a.listing_id,
              price_usd: round(a.price_usd, 2),
              active: a.listing_active === true,
              subscribers_active: Number(a.subs_active),
              subscribers_grace: Number(a.subs_grace),
            }
          : null,
        wallet: a.wallet_address
          ? { address: a.wallet_address, key_custody: a.key_custody }
          : null,
        gas,
        last_reason_code: lastReason?.reason_code ?? null,
        guards: {
          armed: agentGuards.filter((g) => g.status === 'armed').length,
          held_back: heldBack.length,
          refused: refused.length,
        },
      };
    });

    const active = items.filter((i) => i.status === 'active').length;

    return {
      creator: {
        id: c.id,
        handle: c.handle,
        wallet_address: c.wallet_address ?? null,
        can_be_paid: !!c.wallet_address,
        reputation_score: rep.value === null ? null : round(rep.value, 2),
        reputation: {
          version: rep.version,
          status: rep.status,
          value: rep.value,
          agents: rep.agents.length,
          note: rep.note,
          url: `/v1/creators/${creatorId}/reputation`,
        },
        status: c.status,
        created_at: c.created_at ? new Date(c.created_at).toISOString() : null,
      },
      slots: {
        active,
        cap: MAX_ACTIVE_AGENTS_PER_CREATOR,
        free: Math.max(0, MAX_ACTIVE_AGENTS_PER_CREATOR - active),
        counts: 'active agents only',
        note:
          `A creator may hold ${MAX_ACTIVE_AGENTS_PER_CREATOR} ACTIVE agents. Retired ones do not count — ` +
          'a cap on the total would charge a creator for their own history and push them towards deleting it. ' +
          'Activating a new version retires the one it replaces in the same transaction, so evolving never ' +
          'needs a free slot.',
      },
      agents: items,
      attention,
      attention_note:
        'Every item here names the row it came from. Low gas is the wallet page\'s own measurement — fewer than ' +
        'ten transactions left at the median gas of the agent\'s own fills — and an agent with too few fills to ' +
        'measure is shown as unknown, not as fine.',
      cost_reference: await this.costReference(),
      as_of: new Date().toISOString(),
    };
  }

  /**
   * What running an agent has actually cost on this platform, for the create
   * form's projection. EVERY FIGURE IS MEASURED OR ABSENT.
   *
   * Tokens per decision and gas per transaction are recorded; a model PRICE is
   * not — nothing on this platform stores what a token cost — so no dollar
   * figure for inference is offered. Live agents only, last 30 days, the
   * agents' own wallets only (a subscriber's gas is the subscriber's).
   */
  private async costReference() {
    const rows = await this.db.query(
      `WITH d AS (
         SELECT dc.id, dc.agent_id, coalesce(dc.prompt_tokens, 0) + coalesce(dc.completion_tokens, 0) AS tokens,
                dc.prompt_tokens IS NOT NULL AS bought_inference
           FROM decisions_counted dc JOIN agents a ON a.id = dc.agent_id AND a.provenance = 'live'
          WHERE dc.ts > now() - interval '30 days'
       ),
       x AS (
         SELECT e.decision_id, e.gas_cost_usd
           FROM executions e JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
          WHERE e.ts > now() - interval '30 days' AND e.subscription_id IS NULL AND e.status = 'mined'
       )
       SELECT (SELECT count(*) FROM d)::int AS decisions,
              (SELECT count(*) FROM d WHERE bought_inference)::int AS decisions_with_inference,
              (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY tokens) FROM d WHERE bought_inference)::int AS median_tokens,
              (SELECT count(DISTINCT decision_id) FROM x WHERE decision_id IS NOT NULL)::int AS decisions_that_traded,
              (SELECT count(*) FROM x)::int AS mined_transactions,
              (SELECT count(*) FROM x WHERE gas_cost_usd IS NOT NULL)::int AS priced_transactions,
              (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY gas_cost_usd) FROM x WHERE gas_cost_usd IS NOT NULL)::float8 AS median_gas_usd`,
    );
    const r = rows[0] ?? {};
    const decisions = Number(r.decisions ?? 0);
    const traded = Number(r.decisions_that_traded ?? 0);
    const mined = Number(r.mined_transactions ?? 0);
    return {
      window: '30 days, live agents, agents\' own wallets',
      decisions,
      median_tokens_per_decision: r.median_tokens === null || r.median_tokens === undefined ? null : Number(r.median_tokens),
      decisions_with_inference: Number(r.decisions_with_inference ?? 0),
      share_of_decisions_that_traded: decisions > 0 ? Number((traded / decisions).toFixed(4)) : null,
      transactions_per_trade: traded > 0 ? Number((mined / traded).toFixed(2)) : null,
      median_gas_usd_per_transaction:
        Number(r.priced_transactions ?? 0) >= 3 && r.median_gas_usd !== null ? Number(Number(r.median_gas_usd).toFixed(4)) : null,
      priced_transactions: Number(r.priced_transactions ?? 0),
      model_price_note:
        'Tokens are recorded per decision; what a token costs is not recorded anywhere on this platform, so no ' +
        'dollar figure for model calls is given.',
    };
  }
}
