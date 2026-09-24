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
    const agent = await this.db.query(`SELECT id FROM agents WHERE id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);

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

    return {
      agent_id: agentId,
      positions,
      // Said beside the numbers, because a reader who assumes otherwise is the
      // bug: these figures are watched, and nothing acts on them yet.
      acting: false,
      note:
        'Read from Morpho and its oracle by the position guard about once a minute. ' +
        'ARCANA does not borrow, repay or deleverage on these figures yet.',
    };
  }
}
