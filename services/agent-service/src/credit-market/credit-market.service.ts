import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { forbidden } from '@arcana/auth';
import { CREDIT_STALE_AFTER_SECONDS, CreditConfig, HELD_BECAUSE, creditConfig, limitForTier } from '../agents/capital-credit';
import { Provenance } from '../common/verification';
import { IndicationDto } from './dto/indication.dto';

/**
 * AGENT CREDIT MARKETS, first step (architecture.md §19): indications of
 * interest.
 *
 * WHAT IT IS. The agents that have a capital record, each with the reputation
 * and the risk figures a lender would choose by, and beside each one what
 * capital providers have said they would supply. A provider is a signed-in
 * wallet; an indication is an amount, optionally a rate, and nothing else.
 *
 * WHAT IT IS NOT. A loan, an escrow or a promise. No transaction is built, the
 * signer is never called, and no limit anywhere reads these rows: every loan is
 * still made by Morpho against posted collateral (§18). `funded: false` is in
 * every response so a client cannot mistake the figures for supplied capital.
 *
 * NOTHING IS SCORED HERE. The reputation, the tier and the cycles are the
 * position guard's rows, returned as written; the limit is computed by the same
 * limitForTier the Passport and the mandate form use.
 *
 * WHO IS LISTED: an agent that has owed something on chain, which is when the
 * guard starts writing it a reputation row. WHO IS QUALIFIED: one that is rated
 * and holds tier 1 or above. The rest are listed as building a record, because
 * a list of qualified agents that hid everybody else would read as "there are
 * no borrowers" on a day when there are and none has thirty days of history.
 */
export const MIN_INDICATION_USDG = 1;
export const MAX_INDICATION_USDG = 1_000_000;
export const MIN_RATE_BPS = 1;
export const MAX_RATE_BPS = 10_000;
/** Standing indications one wallet may hold: a market read, not a mailing list. */
export const MAX_OPEN_INDICATIONS_PER_WALLET = 25;
const LIST_LIMIT = 100;

const refuse = (code: string, message: string) => new BadRequestException({ code, message });

type RepRow = {
  rated: boolean;
  unrated_why: string | null;
  score: number | null;
  earned_tier: number;
  tier: number;
  held_because: string | null;
  confirmed_at: Date | string;
};

/**
 * What an agent holds now, from its newest reputation row. A reputation nobody
 * has re-checked is tier 0 (§18.5), here as on the Passport.
 */
function standing(cfg: CreditConfig, rep: RepRow, now: Date) {
  const confirmedAt = new Date(rep.confirmed_at);
  const stale = (now.getTime() - confirmedAt.getTime()) / 1000 > CREDIT_STALE_AFTER_SECONDS;
  const status: 'rated' | 'unrated' = rep.rated ? 'rated' : 'unrated';
  const tier = stale ? 0 : rep.tier;
  const qualified = cfg.enabled && status === 'rated' && !stale && tier >= 1;
  let why: string | null = null;
  if (!qualified) {
    const tier1 = cfg.tiers.find((t) => t.tier === 1);
    if (!cfg.enabled) why = 'Agent Credit is switched off, so no tier is in force.';
    else if (stale) why = 'Its reputation has not been re-checked for two days, so it holds tier 0 until the guard runs again.';
    else if (status === 'unrated') why = `Unrated: ${rep.unrated_why ?? 'there is not yet enough of a record'}. Unrated is not a low score.`;
    else if (rep.held_because) why = HELD_BECAUSE[rep.held_because] ?? `Its tier is held at 0 (${rep.held_because}).`;
    else why = `Its capital reputation of ${rep.score} is under ${tier1?.min_score ?? 'the score'} that tier 1 needs.`;
  }
  return {
    status,
    score: rep.rated ? rep.score : null,
    unrated_why: rep.rated ? null : rep.unrated_why,
    tier,
    earned_tier: rep.earned_tier,
    held_because: rep.held_because,
    limit_usdg: limitForTier(cfg, rep.tier, confirmedAt, now),
    confirmed_at: rep.confirmed_at,
    stale,
    qualified,
    not_qualified_why: why,
  };
}

@Injectable()
export class CreditMarketService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** 🌐 The market: every listed agent, qualified first, with the interest recorded in it. */
  async market(provenance: Provenance) {
    const cfg = creditConfig();
    const now = new Date();

    const rows = await this.db.query(
      `SELECT a.id, a.name, a.version, a.status, a.visibility, a.strategy_type,
              c.id AS creator_id, c.handle AS creator_handle,
              rep.rated, rep.unrated_why, rep.score, rep.earned_tier, rep.tier, rep.held_because, rep.confirmed_at,
              rep.inputs,
              coalesce(cyc.total, 0) AS loans_total, coalesce(cyc.open, 0) AS loans_open,
              coalesce(cyc.repaid, 0) AS loans_repaid, coalesce(cyc.deleveraged, 0) AS loans_deleveraged,
              coalesce(cyc.liquidated, 0) AS loans_liquidated,
              coalesce(cyc.usdg_days, 0)::float8 AS usdg_days, coalesce(cyc.deleverage_steps, 0) AS deleverage_steps,
              cyc.lowest_hf::float8 AS lowest_health_factor_worst,
              coalesce(liq.n, 0) AS liquidations,
              owed.owed_usdg::float8 AS owed_usdg,
              coalesce(ind.providers, 0) AS providers, coalesce(ind.amount, 0)::float8 AS indicated_usdg,
              ind.rate_low, ind.rate_high
         FROM (SELECT DISTINCT ON (agent_id) *
                 FROM capital_reputation ORDER BY agent_id, computed_at DESC, id DESC) rep
         JOIN agents a ON a.id = rep.agent_id
         LEFT JOIN creators c ON c.id = a.creator_id
         LEFT JOIN (SELECT agent_id, count(*)::int AS total,
                           count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
                           count(*) FILTER (WHERE closed_how = 'repaid')::int AS repaid,
                           count(*) FILTER (WHERE closed_how = 'deleveraged')::int AS deleveraged,
                           count(*) FILTER (WHERE closed_how = 'liquidated')::int AS liquidated,
                           sum(usdg_days) AS usdg_days, sum(deleverage_steps)::int AS deleverage_steps,
                           min(lowest_health_factor_worst) AS lowest_hf
                      FROM capital_cycles GROUP BY agent_id) cyc ON cyc.agent_id = a.id
         LEFT JOIN (SELECT agent_id, count(*)::int AS n FROM capital_liquidations GROUP BY agent_id) liq
                ON liq.agent_id = a.id
         LEFT JOIN LATERAL (SELECT coalesce(sum(debt_usdg), 0) AS owed_usdg FROM (
                              SELECT DISTINCT ON (market_id) debt_usdg FROM capital_positions p
                               WHERE p.agent_id = a.id ORDER BY market_id, ts DESC) latest) owed ON true
         LEFT JOIN (SELECT agent_id, count(*)::int AS providers, sum(amount_usdg) AS amount,
                           min(rate_bps) AS rate_low, max(rate_bps) AS rate_high
                      FROM credit_market_indications
                     WHERE ended_at IS NULL AND provenance = $1 GROUP BY agent_id) ind ON ind.agent_id = a.id
        WHERE a.provenance = $1 AND a.status NOT IN ('draft', 'retired')
        LIMIT ${LIST_LIMIT + 1}`,
      [provenance],
    );
    // Zero liquidations is a measurement only if the event scan has run (§18.3).
    const cursor = await this.db.query(`SELECT max(updated_at) AS scanned_at FROM capital_scan_cursors`);
    const scanned = !!cursor[0]?.scanned_at;
    const totals = await this.db.query(
      `SELECT count(*)::int AS indications, count(DISTINCT provider_wallet)::int AS providers,
              coalesce(sum(amount_usdg), 0)::float8 AS indicated_usdg
         FROM credit_market_indications i JOIN agents a ON a.id = i.agent_id
        WHERE i.ended_at IS NULL AND i.provenance = $1 AND a.provenance = $1
          AND a.status NOT IN ('draft', 'retired')`,
      [provenance],
    );

    const agents = rows.slice(0, LIST_LIMIT).map((r: any) => {
      const s = standing(cfg, r, now);
      return {
        agent_id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        visibility: r.visibility,
        strategy_type: r.strategy_type,
        creator: r.creator_id ? { id: r.creator_id, handle: r.creator_handle } : null,
        capital: {
          status: s.status, score: s.score, unrated_why: s.unrated_why, tier: s.tier, earned_tier: s.earned_tier,
          held_because: s.held_because, limit_usdg: s.limit_usdg, confirmed_at: s.confirmed_at, stale: s.stale,
        },
        // THE RISK PROFILE: what the record says about how the agent carried
        // debt, in the figures the reputation was computed from.
        risk: {
          loans: {
            total: r.loans_total, open: r.loans_open, repaid: r.loans_repaid,
            deleveraged: r.loans_deleveraged, liquidated: r.loans_liquidated,
          },
          usdg_days: r.usdg_days,
          lowest_health_factor_worst: r.lowest_health_factor_worst,
          share_under_floor: r.inputs?.figures?.share_under_floor ?? null,
          deleverage_steps: r.deleverage_steps,
          liquidations: scanned ? r.liquidations : null,
          owed_usdg: r.owed_usdg,
        },
        qualified: s.qualified,
        not_qualified_why: s.not_qualified_why,
        interest: {
          providers: r.providers,
          indicated_usdg: r.indicated_usdg,
          // The lowest and highest yearly rate named, among those that named one.
          rate_bps_low: r.rate_low,
          rate_bps_high: r.rate_high,
        },
      };
    });
    // Qualified first, then the tier held, then the score, then the evidence.
    agents.sort((x: any, y: any) =>
      Number(y.qualified) - Number(x.qualified) ||
      y.capital.tier - x.capital.tier ||
      (y.capital.score ?? -1) - (x.capital.score ?? -1) ||
      y.risk.usdg_days - x.risk.usdg_days);

    return {
      as_of: now.toISOString(),
      // No capital has been supplied through this market, and none can be.
      funded: false,
      credit_enabled: cfg.enabled,
      tiers: cfg.tiers,
      ceiling_usdg: cfg.ceiling_usdg,
      totals: {
        agents: agents.length,
        qualified: agents.filter((a: any) => a.qualified).length,
        indications: totals[0]?.indications ?? 0,
        providers: totals[0]?.providers ?? 0,
        indicated_usdg: totals[0]?.indicated_usdg ?? 0,
      },
      truncated: rows.length > LIST_LIMIT,
      agents,
      limits: {
        min_amount_usdg: MIN_INDICATION_USDG,
        max_amount_usdg: MAX_INDICATION_USDG,
        min_rate_bps: MIN_RATE_BPS,
        max_rate_bps: MAX_RATE_BPS,
        max_open_per_wallet: MAX_OPEN_INDICATIONS_PER_WALLET,
      },
      note:
        'An indication is what a capital provider says they would supply to an agent. It is not a loan, an ' +
        'escrow or a promise: no money moves through this market, and every loan is still made by Morpho against ' +
        'the agent\'s own collateral. Listed agents have owed something on chain; qualified ones are rated and ' +
        'hold tier 1 or above.',
    };
  }

  /** 🔒 What this wallet has indicated: what stands, and the last of what ended. */
  async mine(wallet: string) {
    const w = wallet.toLowerCase();
    const rows = await this.db.query(
      `SELECT i.id, i.agent_id, a.name AS agent_name, a.status AS agent_status,
              i.amount_usdg::float8 AS amount_usdg, i.rate_bps,
              i.agent_status_at, i.agent_score_at, i.agent_tier_at, i.created_at, i.ended_at, i.ended_how
         FROM credit_market_indications i JOIN agents a ON a.id = i.agent_id
        WHERE i.provider_wallet = $1
        ORDER BY (i.ended_at IS NULL) DESC, i.created_at DESC, i.id DESC LIMIT 100`,
      [w],
    );
    const view = (r: any) => ({
      id: Number(r.id),
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      agent_status: r.agent_status,
      amount_usdg: r.amount_usdg,
      rate_bps: r.rate_bps,
      // The agent's standing when this was written, not now.
      agent_at: { status: r.agent_status_at, score: r.agent_score_at, tier: r.agent_tier_at },
      created_at: r.created_at,
      ended_at: r.ended_at,
      ended_how: r.ended_how,
    });
    const open = rows.filter((r: any) => r.ended_at === null).map(view);
    return {
      wallet: w,
      funded: false,
      open,
      open_total_usdg: open.reduce((s: number, i: any) => s + i.amount_usdg, 0),
      ended: rows.filter((r: any) => r.ended_at !== null).map(view),
      max_open: MAX_OPEN_INDICATIONS_PER_WALLET,
    };
  }

  /**
   * 🔒 Record, or change, what this wallet would supply to one agent.
   *
   * A change ends the standing row as 'replaced' and writes a new one, so the
   * record keeps what was said before. The wallet's writes are serialised by an
   * advisory lock: two requests at once would otherwise both find no standing
   * row and the second would fail on the unique index instead of replacing.
   */
  async indicate(wallet: string, agentId: string, dto: IndicationDto, provenance: Provenance) {
    const w = wallet.toLowerCase();
    const amount = dto.amount_usdg;
    if (!Number.isFinite(amount) || amount < MIN_INDICATION_USDG || amount > MAX_INDICATION_USDG) {
      throw refuse('amount_out_of_range',
        `An indication is between ${MIN_INDICATION_USDG} and ${MAX_INDICATION_USDG} USDG. Got ${amount}.`);
    }
    const rate = dto.rate_bps ?? null;
    if (rate !== null && (rate < MIN_RATE_BPS || rate > MAX_RATE_BPS)) {
      throw refuse('rate_out_of_range',
        `The rate is in basis points a year, between ${MIN_RATE_BPS} and ${MAX_RATE_BPS}, or left out. Got ${rate}.`);
    }

    const agent = await this.db.query(
      `SELECT a.id, a.status, c.wallet_address AS owner_wallet
         FROM agents a LEFT JOIN creators c ON c.id = a.creator_id WHERE a.id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    // INTEREST IN ONE'S OWN AGENT IS NOT INTEREST. It would let an owner print
    // demand beside their agent's name for the price of a sign-in.
    if ((agent[0].owner_wallet ?? '').toLowerCase() === w) {
      throw forbidden('own_agent', 'This agent is yours. An indication records what somebody else would supply to it.');
    }
    const rep = await this.db.query(
      `SELECT rated, unrated_why, score, earned_tier, tier, held_because, confirmed_at
         FROM capital_reputation WHERE agent_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [agentId]);
    if (rep.length === 0 || agent[0].status === 'draft' || agent[0].status === 'retired') {
      throw refuse('agent_not_listed',
        rep.length === 0
          ? 'This agent has never borrowed, so it has no capital record and is not in the credit market.'
          : `This agent is ${agent[0].status} and is not in the credit market.`);
    }
    const s = standing(creditConfig(), rep[0], new Date());

    await this.db.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`credit_market:${w}`]);
      const standingRows = await m.query(
        `SELECT agent_id FROM credit_market_indications WHERE provider_wallet = $1 AND ended_at IS NULL`, [w]);
      const replacing = standingRows.some((r: any) => r.agent_id === agentId);
      if (!replacing && standingRows.length >= MAX_OPEN_INDICATIONS_PER_WALLET) {
        throw refuse('too_many_indications',
          `A wallet may hold ${MAX_OPEN_INDICATIONS_PER_WALLET} standing indications. Withdraw one before adding another.`);
      }
      await m.query(
        `UPDATE credit_market_indications SET ended_at = now(), ended_how = 'replaced'
          WHERE provider_wallet = $1 AND agent_id = $2 AND ended_at IS NULL`, [w, agentId]);
      await m.query(
        `INSERT INTO credit_market_indications
           (agent_id, provider_wallet, amount_usdg, rate_bps, agent_status_at, agent_score_at, agent_tier_at, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [agentId, w, amount, rate, s.status, s.score, s.tier, provenance]);
    });
    return this.mine(w);
  }

  /** 🔒 Take an indication back. The row stays, ended as 'withdrawn'. */
  async withdraw(wallet: string, agentId: string) {
    const w = wallet.toLowerCase();
    // Existence is read, not inferred from the UPDATE: TypeORM hands an UPDATE
    // back as [rows, count], so its length says nothing.
    const open = await this.db.query(
      `SELECT 1 FROM credit_market_indications WHERE provider_wallet = $1 AND agent_id = $2 AND ended_at IS NULL`,
      [w, agentId]);
    if (open.length === 0) throw refuse('no_indication', 'This wallet has no standing indication for this agent.');
    await this.db.query(
      `UPDATE credit_market_indications SET ended_at = now(), ended_how = 'withdrawn'
        WHERE provider_wallet = $1 AND agent_id = $2 AND ended_at IS NULL`, [w, agentId]);
    return this.mine(w);
  }
}
