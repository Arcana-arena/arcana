import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * ARCANA CAPITAL: what an agent owes, what backs it, and how close it is to
 * liquidation — as the position guard last read it from the chain.
 *
 * READ-ONLY, AND NOTHING IS COMPUTED HERE. The guard writes capital_positions
 * from Morpho and the oracle (services/decision-engine/internal/execution/
 * capital.go); this returns those rows as written. A second implementation of
 * a health factor would agree with the first on every day it still agreed.
 *
 * PUBLIC, INCLUDING FOR A PRIVATE AGENT. What an agent owes is on chain for
 * anyone to read; withholding it here would hide nothing and would make the
 * platform the one place it cannot be seen. A private agent withholds its
 * strategy, not its balance sheet (migration 0047).
 *
 * `watched_at` is the time of the latest read, and `stale` says when it is old
 * enough that the page should not present it as current: the reader runs about
 * once a minute, so a row ten minutes old means the reader has stopped.
 */
const STALE_AFTER_SECONDS = 600;

@Injectable()
export class AgentCapitalService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async forAgent(agentId: string) {
    const agent = await this.db.query(`SELECT id, visibility FROM agents WHERE id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    const isPrivate = agent[0].visibility === 'private';

    const rows = await this.db.query(
      `SELECT DISTINCT ON (market_id)
              market_id, wallet, ts, collateral_symbol,
              collateral_qty::float8          AS collateral_qty,
              collateral_value_usdg::float8   AS collateral_value_usdg,
              debt_usdg::float8               AS debt_usdg,
              lltv::float8                    AS lltv,
              oracle_price_usdg::float8       AS oracle_price_usdg,
              pool_price_usdg::float8         AS pool_price_usdg,
              health_factor::float8           AS health_factor,
              health_factor_worst::float8     AS health_factor_worst,
              liquidation_price_usdg::float8  AS liquidation_price_usdg,
              base_feed_age_s, quote_feed_age_s, oracle_paused
         FROM capital_positions
        WHERE agent_id = $1
        ORDER BY market_id, ts DESC`,
      [agentId],
    );

    const now = Date.now();
    const positions = rows
      // A closing row of zeros is how a repaid position is recorded; it is
      // not a position, so it is not listed as one.
      .filter((r: any) => r.collateral_qty > 0 || r.debt_usdg > 0)
      .map((r: any) => {
        const age = Math.round((now - new Date(r.ts).getTime()) / 1000);
        return {
          market_id: r.market_id,
          wallet: r.wallet,
          collateral: {
            symbol: r.collateral_symbol,
            quantity: r.collateral_qty,
            value_usdg: r.collateral_value_usdg,
          },
          debt_usdg: r.debt_usdg,
          lltv: r.lltv,
          // Morpho's own health factor, on the oracle price: what liquidation
          // is decided on. Null when nothing is owed.
          health_factor: r.health_factor,
          // On the lower of the oracle and the pool price. Over a weekend the
          // oracle holds Friday's close while the token keeps trading; this is
          // the number that says what Monday's open could do.
          health_factor_worst: r.health_factor_worst,
          liquidation_price_usdg: r.liquidation_price_usdg,
          prices: { oracle_usdg: r.oracle_price_usdg, pool_usdg: r.pool_price_usdg },
          oracle: {
            base_feed_age_seconds: r.base_feed_age_s,
            quote_feed_age_seconds: r.quote_feed_age_s,
            paused: r.oracle_paused,
          },
          watched_at: r.ts,
          stale: age > STALE_AFTER_SECONDS,
        };
      });

    // THE CAPITAL DECISION LOG (capital_actions): every action the mandate
    // chose and every refusal, with the inputs it was taken on. A private
    // agent's reasons and evidence carry its mandate's levels, which are risk
    // rules and are withheld; what it DID — the action, the amount, the
    // outcome and the transaction — stays public (migration 0047).
    const mandate = await this.db.query(
      `SELECT status, activated_at FROM capital_mandates WHERE agent_id = $1`, [agentId]);
    const actions = await this.db.query(
      `SELECT id, ts, kind, amount::float8 AS amount, reason_code, why, evidence, status,
              refusal_code, refusal_detail, tx_hash, approve_tx_hash, decider
         FROM capital_actions WHERE agent_id = $1 ORDER BY ts DESC, id DESC LIMIT 50`, [agentId]);

    // THE CAPITAL RECORD, beside the ARCANA Score and never inside it (§17.3).
    // Only what the rows prove: what was borrowed and repaid through ARCANA,
    // the interest that costs (repaid plus still owed, less borrowed), the
    // lowest worst-case health factor any reading saw, and how often the guard
    // had to deleverage. A liquidation is not detected yet, and the record says
    // so rather than printing a zero.
    const rec = await this.db.query(
      `SELECT coalesce(sum(amount) FILTER (WHERE kind = 'borrow' AND status = 'mined'), 0)::float8 AS borrowed,
              coalesce(sum(amount) FILTER (WHERE kind = 'repay' AND status = 'mined'), 0)::float8 AS repaid,
              coalesce(sum(amount) FILTER (WHERE kind = 'deleverage' AND reason_code = 'deleverage_repay' AND status = 'mined'), 0)::float8 AS deleverage_repaid,
              count(*) FILTER (WHERE kind = 'deleverage' AND status = 'mined')::int AS deleverage_steps,
              min(ts) FILTER (WHERE status = 'mined') AS first_action_at
         FROM capital_actions WHERE agent_id = $1`, [agentId]);
    const low = await this.db.query(
      `SELECT min(health_factor_worst)::float8 AS lowest FROM capital_positions
        WHERE agent_id = $1 AND health_factor_worst IS NOT NULL`, [agentId]);
    const owed = positions.reduce((s: number, p: any) => s + (p.debt_usdg ?? 0), 0);
    const r0 = rec[0] ?? {};
    const repaidTotal = (r0.repaid ?? 0) + (r0.deleverage_repaid ?? 0);
    const record = {
      borrowed_usdg: r0.borrowed ?? 0,
      repaid_usdg: repaidTotal,
      owed_usdg: owed,
      interest_usdg: Math.max(0, repaidTotal + owed - (r0.borrowed ?? 0)),
      lowest_health_factor_worst: low[0]?.lowest ?? null,
      deleverage_steps: r0.deleverage_steps ?? 0,
      since: r0.first_action_at ?? null,
      liquidations: null,
      liquidations_note: 'Not detected yet: a liquidation by a third party leaves no ARCANA row, and reading it from the chain is not built.',
    };

    const acting = mandate[0]?.status === 'active';
    return {
      agent_id: agentId,
      positions,
      mandate: mandate[0] ? { status: mandate[0].status, activated_at: mandate[0].activated_at } : null,
      record,
      actions: actions.map((a: any) => ({
        id: Number(a.id), ts: a.ts, kind: a.kind, amount: a.amount, status: a.status,
        reason_code: a.reason_code, decider: a.decider,
        refusal_code: a.refusal_code,
        tx_hash: a.tx_hash, approve_tx_hash: a.approve_tx_hash,
        ...(isPrivate
          ? { why: null, refusal_detail: null, evidence: 'withheld' }
          : { why: a.why, refusal_detail: a.refusal_detail, evidence: a.evidence }),
      })),
      // Said beside the numbers, because a reader who assumes otherwise is the
      // bug: whether anything acts on these figures is the mandate's status.
      acting,
      note: acting
        ? 'Read from Morpho by the position guard about once a minute. An active capital mandate ' +
          'decides on this agent\'s cadence; every action and refusal is listed below.'
        : 'Read from Morpho by the position guard about once a minute. No capital mandate is active, ' +
          'so nothing borrows, repays or supplies on these figures.',
    };
  }
}
