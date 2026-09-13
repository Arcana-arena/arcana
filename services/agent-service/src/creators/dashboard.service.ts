import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MAX_ACTIVE_AGENTS_PER_CREATOR } from '../agents/agents.service';
import { MIN_DECISIONS } from '../common/ranking';
import { creatorReputation } from '../reputation/creator-reputation';

/**
 * One creator's own dashboard, assembled once.
 *
 * WHAT MAKES THIS DIFFERENT FROM /v1/creators/:id/agents. That endpoint is
 * public and returns identity plus a score. A dashboard has to answer the two
 * questions an owner actually opens it with — "is anything wrong" and "how many
 * slots do I have left" — and neither is in a list of agents.
 *
 * THE SLOT CAP IS PUBLISHED HERE, and it had to come from somewhere. It is a
 * constant in this service, and the /me page carried a comment saying it could
 * not print "n of 3" because no response contained the 3. So the response
 * contains it, with the note that it counts ACTIVE agents: a creator with nine
 * retired agents and two live ones has a slot free, and a cap on the total
 * would charge them for their own history.
 *
 * "NEEDS ATTENTION" IS DERIVED FROM THE RECORD, NEVER FROM A GUESS. Each item
 * names the row it came from. The one the design asks for that is NOT here is a
 * low-gas warning: this service does not read chain balances, and inventing a
 * threshold against a balance nobody fetched would be a warning with no
 * measurement behind it. The wallet endpoint reads balances and warns there.
 */

export type Attention = {
  agent_id: string;
  agent_name: string | null;
  kind: 'paused_by_meter' | 'unguarded_position' | 'guard_held_back' | 'no_wallet' | 'unranked' | 'quiet';
  detail: string;
  since: string | null;
};

@Injectable()
export class CreatorDashboardService {
  private readonly quietMinutes: number;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    // The same threshold the status page uses, and configurable for the same
    // reason: a cadence this deployment does not run yet would make every agent
    // look stalled.
    const q = Number(config.get<string>('AGENT_QUIET_MINUTES') ?? '180');
    this.quietMinutes = Number.isFinite(q) && q > 0 ? q : 180;
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
        SELECT DISTINCT ON (p.agent_id) p.agent_id, ps.nav::float8 AS nav, ps.cash::float8 AS cash, ps.ts
          FROM portfolio_snapshots ps
          JOIN portfolios p ON p.id = ps.portfolio_id
         ORDER BY p.agent_id, ps.ts DESC
      ),
      counted AS (
        SELECT agent_id, count(*)::int AS decisions, max(ts) AS last_decision
          FROM decisions_counted GROUP BY agent_id
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
             n.nav, n.cash, n.ts AS nav_at,
             coalesce(d.decisions, 0) AS decisions, d.last_decision,
             li.listing_id, li.price_usd, li.active AS listing_active,
             coalesce(li.subs_active, 0) AS subs_active,
             coalesce(li.subs_grace, 0) AS subs_grace,
             w.address AS wallet_address, w.key_custody
        FROM agents a
        LEFT JOIN latest_score s ON s.agent_id = a.id
        LEFT JOIN latest_nav   n ON n.agent_id = a.id
        LEFT JOIN counted      d ON d.agent_id = a.id
        LEFT JOIN listed      li ON li.agent_id = a.id
        LEFT JOIN agent_wallets w ON w.agent_id = a.id
       WHERE a.creator_id = $1
       ORDER BY (a.status = 'active') DESC, a.created_at DESC`,
      [creatorId],
    );

    // THE PROTECTIVE STATE OF EVERY AGENT AT ONCE. One query rather than one
    // per card: an owner with three agents should not pay three round trips to
    // be told a stop is held back, and the item that matters most is the one
    // that would be missed if a card failed to load.
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

    const round = (v: unknown, dp: number) =>
      v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp));

    const attention: Attention[] = [];
    const items = agents.map((a) => {
      const agentGuards = guards.filter((g) => g.agent_id === a.id);
      const heldBack = agentGuards.filter((g) => g.status === 'armed' && g.last_refusal_at);
      const refused = agentGuards.filter((g) => g.status === 'refused');
      const lastReason = pausedBy.get(a.id) ?? null;
      const quietMins =
        a.last_decision ? Math.floor((Date.now() - new Date(a.last_decision).getTime()) / 60000) : null;

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
        nav: round(a.nav, 2),
        cash: round(a.cash, 2),
        nav_at: a.nav_at ? new Date(a.nav_at).toISOString() : null,
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
        'Every item here names the row it came from. A low-gas warning is deliberately absent: this endpoint ' +
        'reads no chain balances, and a threshold applied to a balance nobody fetched would be a warning with ' +
        'no measurement behind it. The wallet endpoint reads balances and warns there.',
      as_of: new Date().toISOString(),
    };
  }
}
