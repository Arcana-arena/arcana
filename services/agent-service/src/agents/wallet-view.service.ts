import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AUTH_CONFIG, authUnavailable, type AuthConfig } from '@arcana/auth';
import { Inject } from '@nestjs/common';

/**
 * An agent's wallet, as its owner needs to see it: what is in it, what moved,
 * and whether it can still act.
 *
 * TWO BALANCES AND THEY ARE NOT INTERCHANGEABLE. The settlement token is the
 * money; the native balance is the ability to spend it. An agent with a full
 * book and no gas cannot sell — and, on this platform, cannot fire a protective
 * stop either, because a stop is a swap like any other. So the gas figure is
 * not a footnote on this screen; it is the number that decides whether the
 * protection works.
 *
 * THE GAS WARNING IS COMPUTED FROM A MEASUREMENT, NOT FROM A ROUND NUMBER. The
 * threshold is the median gas this agent's own recent executions actually cost,
 * multiplied out — so an agent that trades cheaply is not warned because
 * somebody picked 0.002 ETH, and an agent whose fills are expensive is warned
 * before it runs out. When there are no priced executions to measure, no
 * threshold is offered and the response says why rather than inventing one.
 *
 * WHAT THE TRANSACTION LIST CANNOT SEE, it says. `executions` holds what ARCANA
 * did. A deposit the owner made from their own wallet, or a withdrawal they
 * signed with an exported key, never passes through this platform and is not in
 * this table. Presenting it as "the wallet's transactions" would quietly claim
 * a completeness it does not have.
 */
@Injectable()
export class AgentWalletViewService {
  private readonly arcaUrl: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
    config: ConfigService,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://127.0.0.1:3004';
  }

  async balances(agentId: string) {
    const rows = await this.db.query(
      `SELECT a.id::text, a.name, a.status, w.address, w.key_custody
         FROM agents a LEFT JOIN agent_wallets w ON w.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    const a = rows[0];

    if (!a.address) {
      // NO WALLET IS NOT AN EMPTY WALLET. An agent with no derived address has
      // nowhere for money to be, which is a different thing to fix from a
      // wallet that is empty.
      return {
        agent_id: a.id,
        address: null,
        has_wallet: false,
        note:
          'This agent has no trading wallet yet. Derive one with GET /v1/agents/:id/wallet. There is ' +
          'no balance to read — not a balance of zero.',
        token: null,
        native: null,
        gas: null,
      };
    }

    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so this service cannot reach the chain reader. No balance can be ' +
        'stated — and an unread balance must not be shown as zero.',
      );
    }

    let chain: Record<string, any> | null = null;
    let chainError: string | null = null;
    try {
      const res = await fetch(
        `${this.arcaUrl}/internal/v1/chain/balances?address=${encodeURIComponent(a.address)}`,
        { headers: { 'X-Internal-Key': this.authCfg.internalKey } },
      );
      if (res.ok) chain = (await res.json()) as Record<string, any>;
      else chainError = `the chain reader answered ${res.status}`;
    } catch (e) {
      chainError = `the chain reader could not be reached (${e instanceof Error ? e.message : String(e)})`;
    }

    return {
      agent_id: a.id,
      address: a.address,
      has_wallet: true,
      key_custody: a.key_custody,
      token: chain?.token ?? { available: false, reason: chainError, amount: null, raw: null },
      native: chain?.native ?? { available: false, reason: chainError, amount: null, raw: null },
      gas: await this.gasRunway(agentId, chain?.native?.raw ?? null),
      note: chainError,
      as_of: new Date().toISOString(),
    };
  }

  /**
   * How much longer this wallet can pay for its own transactions.
   *
   * MEASURED FROM THIS AGENT'S OWN FILLS. The median gas of its recent priced
   * executions is what its next one is likely to cost; a platform-wide constant
   * would warn the wrong agents. Fewer than three priced executions is not
   * enough to take a median from, and the answer then is that it is unknown —
   * not a default that looks like a measurement.
   */
  private async gasRunway(agentId: string, weiBalance: string | null) {
    const rows = await this.db.query(
      `SELECT count(*)::int AS priced,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY gas_cost_wei)::text AS median_wei,
              count(*) FILTER (WHERE ts > now() - interval '7 days')::int AS last_7d
         FROM executions
        -- THE AGENT'S OWN WALLET ONLY. An execution carrying a subscription_id
        -- happened in a SUBSCRIBER's wallet and was paid for with their gas;
        -- folding those in would measure this wallet against somebody else's
        -- costs and warn the wrong person.
        WHERE agent_id = $1 AND subscription_id IS NULL
          AND gas_cost_wei IS NOT NULL AND gas_cost_wei > 0`,
      [agentId],
    );
    const r = rows[0] ?? {};
    const priced = Number(r.priced ?? 0);

    if (priced < 3 || !r.median_wei) {
      return {
        known: false,
        reason:
          `${priced} priced execution(s) on record. A median needs at least three to mean anything, so ` +
          'no gas runway is offered. A platform-wide default here would warn the wrong agents and ' +
          'reassure the wrong ones.',
        median_gas_wei: null,
        transactions_affordable: null,
        low: null,
      };
    }
    if (weiBalance === null) {
      return {
        known: false,
        reason: 'The native balance could not be read, so nothing can be divided by the cost of a transaction.',
        median_gas_wei: String(r.median_wei),
        transactions_affordable: null,
        low: null,
      };
    }

    const median = BigInt(r.median_wei);
    const balance = BigInt(weiBalance);
    const affordable = median > 0n ? Number(balance / median) : null;

    return {
      known: true,
      reason: null,
      median_gas_wei: median.toString(),
      measured_from: priced,
      executions_last_7d: Number(r.last_7d ?? 0),
      transactions_affordable: affordable,
      // A THRESHOLD WITH A REASON. Ten transactions is roughly a day for an
      // agent trading hourly and a fortnight for one trading weekly, which is
      // why the count is reported beside it rather than a time.
      low: affordable !== null && affordable < 10,
      note:
        affordable === null
          ? null
          : `At the median cost of this agent's own recent fills, the balance covers about ${affordable} ` +
            'more transactions. A protective stop is a transaction too: at zero gas an armed level ' +
            'cannot fire.',
    };
  }

  /**
   * What this wallet did, as far as ARCANA can see.
   *
   * FROM `executions`, WHICH IS NOT THE SAME AS THE ADDRESS'S HISTORY. Anything
   * the owner signed themselves — a deposit, a withdrawal with an exported key —
   * never reached this platform and is not here. The response says so instead of
   * letting a short list read as a complete one.
   */
  async transactions(agentId: string, limit: number) {
    const rows = await this.db.query(
      `SELECT id, ts, intent_action, symbol, status, tx_hash,
              amount_in::text AS amount_in, filled_out::text AS filled_out,
              token_in, token_out, block_number::text AS block_number,
              gas_cost_usd::float8 AS gas_cost_usd, gas_cost_wei::text AS gas_cost_wei,
              slippage_bps::float8 AS slippage_bps, pool_fee_usd::float8 AS pool_fee_usd,
              guard_id, refusal_code, note
         FROM executions
        -- The agent's own wallet. Rows with a subscription_id belong to a
        -- subscriber's wallet, not this one.
        WHERE agent_id = $1 AND subscription_id IS NULL
        ORDER BY ts DESC, id DESC
        LIMIT $2`,
      [agentId, Math.max(1, Math.min(200, limit))],
    );

    const totals = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'mined')::int AS mined,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE tx_hash IS NULL)::int AS never_sent,
              count(*) FILTER (WHERE gas_cost_wei IS NULL)::int AS unpriced
         FROM executions WHERE agent_id = $1 AND subscription_id IS NULL`,
      [agentId],
    );

    return {
      agent_id: agentId,
      items: rows.map((r: Record<string, any>) => ({
        id: Number(r.id),
        ts: r.ts ? new Date(r.ts).toISOString() : null,
        action: r.intent_action ?? null,
        symbol: r.symbol ?? null,
        status: r.status ?? null,
        tx_hash: r.tx_hash ?? null,
        block_number: r.block_number ?? null,
        amount_in: r.amount_in ?? null,
        filled_out: r.filled_out ?? null,
        token_in: r.token_in ?? null,
        token_out: r.token_out ?? null,
        gas_cost_usd: r.gas_cost_usd ?? null,
        gas_cost_wei: r.gas_cost_wei ?? null,
        // AN UNPRICED EXECUTION IS NOT A FREE ONE. It moved funds and the ETH
        // price could not be read at the time, so the bill is incomplete —
        // the same fact the cost meter refuses to treat as zero.
        gas_note:
          r.gas_cost_wei === null
            ? 'This execution has no recorded gas cost. It was not free — the price feed could not be read.'
            : null,
        slippage_bps: r.slippage_bps ?? null,
        pool_fee_usd: r.pool_fee_usd ?? null,
        // A guard id means the platform fired this, not the agent.
        fired_by_guard: r.guard_id !== null && r.guard_id !== undefined,
        refusal_code: r.refusal_code ?? null,
        note: r.note ?? null,
      })),
      totals: {
        executions: Number(totals[0]?.total ?? 0),
        mined: Number(totals[0]?.mined ?? 0),
        failed: Number(totals[0]?.failed ?? 0),
        never_sent: Number(totals[0]?.never_sent ?? 0),
        unpriced: Number(totals[0]?.unpriced ?? 0),
      },
      completeness:
        'These are the transactions ARCANA made for this agent. Deposits and withdrawals the owner signed ' +
        'themselves never pass through this platform and are NOT in this list — read the address on a ' +
        'block explorer for the full history of the account.',
      as_of: new Date().toISOString(),
    };
  }
}
