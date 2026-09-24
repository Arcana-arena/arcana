import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { CapitalMandateDto } from './dto/capital-mandate.dto';

/**
 * The owner's capital mandate: saved, activated, stopped.
 *
 * THE VALIDATION IS THE PRODUCT (architecture.md §17.7 day 6). Each rule here
 * refuses with a code and a sentence, and each is also enforced somewhere that
 * does not trust this file: the database's CHECK constraints (migration 0059),
 * the engine's capital.Validate on every proposed action, and the signer's own
 * caps. This is the one that explains itself to a person.
 *
 *   min_health_factor   at least 1.5. Morpho liquidates at 1.0, and over a
 *                       weekend the NVDA feed holds Friday's price while the
 *                       token trades (docs/go-no-go-lending.md condition 3), so
 *                       the floor must clear liquidation BY A MARGIN.
 *   max_borrow_usdg     above zero and no higher than the signer's per-agent
 *                       cap. A mandate cannot raise the platform's cap (§17.6).
 *   liquidity_trigger   between zero and the borrow cap.
 *   never_sell          every symbol one the agent can actually hold — an
 *                       allowlisted token. A symbol it can never hold is a
 *                       promise about nothing.
 *
 * READ FROM THE SIGNER'S ALLOWLIST FILE, not a copy. The signer refuses what
 * this file does not; if the two ever disagreed, the owner would save a
 * mandate the signer then refuses, and find out on the first borrow.
 */
export const MIN_HEALTH_FACTOR = 1.5;
export const MAX_HEALTH_FACTOR = 10;

type Allowlist = {
  tokens: Array<{ symbol: string }>;
  lending?: {
    enabled: boolean;
    markets: Array<{ id: string; name: string }>;
    limits: { max_borrow_per_tx_usdg: string; max_debt_per_agent_usdg: string };
  };
};

function allowlist(): Allowlist {
  const path = process.env.CAPITAL_ALLOWLIST_FILE
    || resolve(process.cwd(), '../signer/allowlist/robinhood-mainnet.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * What a mandate may be and what the platform allows, read from the signer's
 * allowlist. Shared with the docs parameters, so the page that explains
 * ARCANA CAPITAL quotes the same numbers the form enforces and the signer caps.
 */
export function capitalLimits() {
  const a = allowlist();
  const l = a.lending;
  return {
    lending_enabled: l?.enabled === true,
    market: l?.markets?.[0] ? { id: l.markets[0].id, name: l.markets[0].name } : null,
    min_health_factor: MIN_HEALTH_FACTOR,
    max_health_factor: MAX_HEALTH_FACTOR,
    platform_max_debt_usdg: l ? Number(l.limits.max_debt_per_agent_usdg) : 0,
    platform_max_borrow_per_tx_usdg: l ? Number(l.limits.max_borrow_per_tx_usdg) : 0,
    symbols: a.tokens.map((t) => t.symbol),
  };
}

const refuse = (code: string, message: string) => new BadRequestException({ code, message });

@Injectable()
export class CapitalMandateService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** What a mandate may be, for the form to show before anyone types. */
  limits() {
    return capitalLimits();
  }

  async get(agentId: string) {
    const rows = await this.db.query(
      `SELECT market_id, min_health_factor::float8 AS min_health_factor, max_borrow_rate_bps,
              liquidity_trigger_usdg::float8 AS liquidity_trigger_usdg, max_borrow_usdg::float8 AS max_borrow_usdg,
              never_sell, status, created_at, updated_at, activated_at
         FROM capital_mandates WHERE agent_id = $1`, [agentId]);
    return { mandate: rows[0] ?? null, limits: this.limits() };
  }

  /** Saves the mandate. A new one is a draft; an edit keeps its status. */
  async save(agentId: string, dto: CapitalMandateDto) {
    const lim = this.limits();
    if (!lim.market) {
      throw refuse('no_lending_market', 'The allowlist lists no lending market, so there is nothing to write a mandate for.');
    }
    const agent = await this.db.query(`SELECT status FROM agents WHERE id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    if (agent[0].status === 'retired') {
      throw refuse('agent_retired', 'A retired agent cannot take a capital mandate.');
    }

    const hf = dto.min_health_factor;
    if (!Number.isFinite(hf) || hf < MIN_HEALTH_FACTOR || hf > MAX_HEALTH_FACTOR) {
      throw refuse('health_floor_too_low',
        `The minimum health factor must be between ${MIN_HEALTH_FACTOR} and ${MAX_HEALTH_FACTOR}. Morpho ` +
        `liquidates at 1.0, and the oracle holds Friday's price over a weekend, so the floor has to leave ` +
        `room for a gap rather than merely clear liquidation. Got ${hf}.`);
    }
    const cap = dto.max_borrow_usdg;
    if (!Number.isFinite(cap) || cap <= 0) {
      throw refuse('borrow_cap_not_positive', `The borrow cap must be above zero. Got ${cap}.`);
    }
    if (cap > lim.platform_max_debt_usdg) {
      throw refuse('borrow_cap_over_platform',
        `The platform allows at most ${lim.platform_max_debt_usdg} USDG of debt per agent during the beta, and a ` +
        `mandate cannot raise it. Got ${cap}.`);
    }
    const trig = dto.liquidity_trigger_usdg;
    if (!Number.isFinite(trig) || trig < 0 || trig > cap) {
      throw refuse('trigger_out_of_range',
        `The liquidity trigger must be between 0 and the borrow cap (${cap} USDG). Got ${trig}.`);
    }
    const listed = new Set(lim.symbols.map((s) => s.toUpperCase()));
    const neverSell = [...new Set(dto.never_sell.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const unknown = neverSell.filter((s) => !listed.has(s));
    if (unknown.length > 0) {
      throw refuse('never_sell_not_holdable',
        `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a token this agent can hold, so ` +
        `listing ${unknown.length === 1 ? 'it' : 'them'} as never-sell would promise nothing. ` +
        `Holdable: ${lim.symbols.join(', ')}.`);
    }

    await this.db.query(
      `INSERT INTO capital_mandates
         (agent_id, market_id, min_health_factor, max_borrow_rate_bps, liquidity_trigger_usdg, max_borrow_usdg, never_sell)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_id) DO UPDATE SET
         market_id = EXCLUDED.market_id, min_health_factor = EXCLUDED.min_health_factor,
         max_borrow_rate_bps = EXCLUDED.max_borrow_rate_bps,
         liquidity_trigger_usdg = EXCLUDED.liquidity_trigger_usdg,
         max_borrow_usdg = EXCLUDED.max_borrow_usdg, never_sell = EXCLUDED.never_sell, updated_at = now()`,
      [agentId, lim.market.id, hf, dto.max_borrow_rate_bps, trig, cap, neverSell]);
    return this.get(agentId);
  }

  /**
   * Activates the mandate. The agent must be active and must have a wallet —
   * a mandate over an account nobody can sign for would be a promise the
   * engine can only ever refuse.
   */
  async activate(agentId: string) {
    const { mandate } = await this.get(agentId);
    if (!mandate) throw refuse('no_mandate', 'Save a mandate before activating it.');
    const agent = await this.db.query(`SELECT status FROM agents WHERE id = $1`, [agentId]);
    if (agent[0]?.status !== 'active') {
      throw refuse('agent_not_active', 'Only an active agent can run a capital mandate. Activate or resume the agent first.');
    }
    const wallet = await this.db.query(`SELECT 1 FROM agent_wallets WHERE agent_id = $1`, [agentId]);
    if (wallet.length === 0) {
      throw refuse('no_wallet', 'This agent has no chain wallet, so there is no position for a mandate to manage.');
    }
    await this.db.query(
      `UPDATE capital_mandates SET status = 'active', activated_at = now(), updated_at = now() WHERE agent_id = $1`,
      [agentId]);
    return this.get(agentId);
  }

  /** Stops the mandate. The position stays watched by the guard (§17.4). */
  async stop(agentId: string) {
    // Existence is read, not inferred from the UPDATE: TypeORM hands an
    // UPDATE back as [rows, count], so its length says nothing.
    const { mandate } = await this.get(agentId);
    if (!mandate) throw refuse('no_mandate', 'There is no mandate to stop.');
    await this.db.query(
      `UPDATE capital_mandates SET status = 'stopped', updated_at = now() WHERE agent_id = $1`, [agentId]);
    return this.get(agentId);
  }
}
