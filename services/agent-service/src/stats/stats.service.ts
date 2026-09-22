import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { decidedBy } from '../common/decided-by';

/**
 * What the platform has actually done — counted once, in SQL, for everyone.
 *
 * WHY THIS EXISTS. The landing page needs eight totals and two cross-agent
 * feeds. Every one of them was readable only per-agent, so a page wanting
 * "decisions recorded" had two options: print nothing, or fan out over every
 * agent in the browser and add up the answers. The second is worse than the
 * first — it is a different number on every load, ordered by whichever request
 * answered first, and it is a second definition of a count the database already
 * knows.
 *
 * EVERY FIGURE HERE IS A COUNT OR A SUM OVER A TABLE. Nothing is estimated,
 * nothing is projected, and where a number cannot be had honestly it is not
 * invented — see `chain` below, which reports the highest block ARCANA has a
 * transaction in and says that is what it is, rather than claiming to be the
 * chain head.
 */

/** The quote token, from services/signer/allowlist/robinhood-mainnet.json. */
const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const USDG_DECIMALS = 6;

/**
 * Rows that are not trades.
 *
 * An ERC-20 `approve` is a transaction and costs gas, but it moves no stock and
 * buys nothing. Counting approvals as executions would roughly double the
 * headline number and make the platform look twice as busy as it is.
 */
const TRADE_ACTIONS = `('buy', 'sell')`;

@Injectable()
export class StatsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async platform() {
    const [agents, creators, decisions, executions, volume, chain, seasons] = await Promise.all([
      this.db.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'active')::int  AS active,
               count(*) FILTER (WHERE status = 'retired')::int AS retired,
               count(*) FILTER (WHERE status = 'draft')::int   AS draft
          FROM agents
         WHERE provenance = 'live'`),
      this.db.query(`SELECT count(*)::int AS total FROM creators WHERE provenance = 'live'`),
      // decisions_counted, not decisions: the view already excludes measurement
      // artefacts, and it is the same population every other surface counts.
      //
      // AND JOINED TO provenance = 'live'. Today that changes nothing — every
      // agent on this platform is live and there is not one verification row —
      // so this is not a number moving, it is a door closing. A verification
      // suite creates agents to prove something and sweeps them afterwards; if
      // one ever outlives its run, the front page must not count its decisions
      // as platform activity. The filter belongs in the query rather than in
      // the page, because every other reader deserves the same answer.
      this.db.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE d.ts > now() - interval '24 hours')::int AS last_24h,
               count(*) FILTER (WHERE d.action <> 'hold')::int AS trades,
               max(d.ts) AS last_at
          FROM decisions_counted d
          JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'`),
      this.db.query(`
        SELECT count(*) FILTER (WHERE e.status = 'mined')::int    AS settled,
               count(*) FILTER (WHERE e.status = 'blocked')::int  AS blocked,
               count(*) FILTER (WHERE e.status = 'reverted')::int AS reverted,
               -- The same settled count over the last day. A FILTER on the
               -- query that already runs, not a second query and certainly not
               -- a subtraction done in the browser.
               count(*) FILTER (WHERE e.status = 'mined'
                                  AND e.ts > now() - interval '24 hours')::int AS settled_24h,
               count(*)::int AS total
          FROM executions e
          JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
         WHERE e.intent_action IN ${TRADE_ACTIONS}`),
      // THE USDG LEG OF EVERY MINED SWAP.
      //
      // A buy spends USDG (token_in) and receives stock; a sell spends stock and
      // receives USDG (filled_out). Both legs are raw integer units, so the
      // divisor is the token's decimals — 6 for USDG — and not a guess.
      // Unsettled rows contribute nothing: a blocked or reverted trade moved no
      // money, and including it would report volume that never happened.
      this.db.query(`
        SELECT coalesce(sum(
                 CASE
                   WHEN lower(e.token_in)  = lower($1) THEN e.amount_in
                   WHEN lower(e.token_out) = lower($1) THEN e.filled_out
                 END
               ) / power(10, $2), 0)::float8 AS usdg,
               -- THE SAME SUM OVER THE LAST DAY, on the same rows and the same
               -- basis. The landing page wants to say what settled today, and
               -- the alternative was the page subtracting yesterday's figure
               -- from today's — arithmetic in a browser, against two reads
               -- taken at different moments.
               coalesce(sum(
                 CASE
                   WHEN e.ts <= now() - interval '24 hours' THEN 0
                   WHEN lower(e.token_in)  = lower($1) THEN e.amount_in
                   WHEN lower(e.token_out) = lower($1) THEN e.filled_out
                 END
               ) / power(10, $2), 0)::float8 AS usdg_24h,
               count(*) FILTER (
                 WHERE lower(e.token_in) <> lower($1) AND lower(e.token_out) <> lower($1)
               )::int AS legs_without_usdg
          FROM executions e
          JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
         WHERE e.status = 'mined' AND e.intent_action IN ${TRADE_ACTIONS}`,
        [USDG_ADDRESS, USDG_DECIMALS]),
      this.db.query(`
        SELECT max(e.block_number)::bigint AS last_block,
               max(e.ts) FILTER (WHERE e.block_number IS NOT NULL) AS last_block_at,
               count(e.block_number)::int AS blocks_seen
          FROM executions e
          JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'`),
      this.db.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE now() >= start_at AND now() <= end_at)::int AS running,
               count(*) FILTER (WHERE now() < start_at)::int AS upcoming,
               count(*) FILTER (WHERE now() > end_at)::int   AS ended
          FROM seasons`),
    ]);

    const c = chain[0] ?? {};
    return {
      agents: agents[0],
      creators: creators[0],
      decisions: {
        ...decisions[0],
        last_at: decisions[0]?.last_at ? new Date(decisions[0].last_at).toISOString() : null,
      },
      executions: executions[0],
      volume: {
        usdg: Number(volume[0]?.usdg ?? 0),
        usdg_24h: Number(volume[0]?.usdg_24h ?? 0),
        // Said plainly, because "volume" with no basis is a number anyone can
        // read as whatever flatters them.
        basis:
          'The USDG side of every settled swap. Approvals, blocked orders and reverted ' +
          'transactions are excluded: none of them moved money.',
        legs_without_usdg: volume[0]?.legs_without_usdg ?? 0,
      },
      chain: {
        id: 4663,
        // NOT "chain height". This is the highest block ARCANA has a
        // transaction in, which is a fact about ARCANA's record and is exactly
        // what the database can answer. The chain head is a different number
        // and would need an RPC call this service does not make.
        last_block_seen: c.last_block === null || c.last_block === undefined ? null : Number(c.last_block),
        last_block_at: c.last_block_at ? new Date(c.last_block_at).toISOString() : null,
        blocks_seen: c.blocks_seen ?? 0,
        note:
          'The highest block ARCANA has a settled transaction in. It is not the chain head — ' +
          'nothing here polls the node for that.',
      },
      seasons: seasons[0],
      as_of: new Date().toISOString(),
    };
  }

  /**
   * The most recent decisions across every agent.
   *
   * ORDERED IN SQL, and by (ts, id) so it is a total order: two decisions
   * written in the same millisecond would otherwise be free to swap places
   * between requests, and a feed that reshuffles is a feed nobody can cite.
   */
  async recentDecisions(limit: number) {
    const rows = await this.db.query(`
      SELECT d.id, d.ts, d.agent_id, a.name AS agent_name, a.version,
             d.action, d.symbol, d.quantity::float8 AS quantity,
             d.decider, d.reason_code,
             e.tx_hash, e.status AS execution_status
        FROM decisions_counted d
        JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
        LEFT JOIN LATERAL (
          SELECT tx_hash, status FROM executions
           WHERE decision_id = d.id ORDER BY ts DESC LIMIT 1
        ) e ON true
       ORDER BY d.ts DESC, d.id DESC
       LIMIT $1`, [limit]);

    return {
      limit,
      items: rows.map((r: any) => ({
        ts: new Date(r.ts).toISOString(),
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        version: r.version,
        action: r.action,
        symbol: r.symbol || null,
        quantity: r.quantity,
        decider: r.decider ?? null,
        reason_code: r.reason_code ?? null,
        decided_by: decidedBy(r),
        tx_hash: r.tx_hash ?? null,
        execution_status: r.execution_status ?? null,
      })),
      as_of: new Date().toISOString(),
    };
  }

  /**
   * Settled trades across every agent — the chain's side of the record.
   *
   * NOT DECISIONS. A decision is what an agent chose; an execution is what the
   * chain did about it, and the two differ whenever an order was blocked,
   * reverted, or filled at a price the model did not see. Presenting one as the
   * other is how a platform reports activity it never had.
   *
   * Blocked and reverted rows are INCLUDED and marked. A reverted transaction
   * still cost gas and is part of the record; hiding it would make execution
   * look perfect.
   */
  async recentExecutions(limit: number) {
    const rows = await this.db.query(`
      WITH head AS (SELECT max(block_number) AS n FROM executions)
      SELECT e.ts, e.agent_id, a.name AS agent_name, a.version,
             e.intent_action, e.symbol, e.status, e.refusal_code,
             e.amount_in::float8 AS amount_in, e.filled_out::float8 AS filled_out,
             e.token_in, e.token_out,
             e.slippage_bps::float8 AS slippage_bps,
             e.tx_hash, e.block_number, e.gas_used,
             e.gas_cost_usd::float8 AS gas_cost_usd,
             e.gas_cost_wei::float8 AS gas_cost_wei,
             d.decider, d.reason_code, d.action AS decision_action,
             (SELECT n FROM head) AS head_block
        FROM executions e
        JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
        LEFT JOIN decisions d ON d.id = e.decision_id
       WHERE e.intent_action IN ${TRADE_ACTIONS}
       ORDER BY e.ts DESC, e.id DESC
       LIMIT $1`, [limit]);

    const dec = (addr: string | null) =>
      addr && addr.toLowerCase() === USDG_ADDRESS.toLowerCase() ? USDG_DECIMALS : 18;

    return {
      limit,
      items: rows.map((r: any) => {
        const inIsUsdg = r.token_in && r.token_in.toLowerCase() === USDG_ADDRESS.toLowerCase();
        const amountIn = r.amount_in === null ? null : r.amount_in / 10 ** dec(r.token_in);
        const filledOut = r.filled_out === null ? null : r.filled_out / 10 ** dec(r.token_out);

        // The two legs, named. For a buy the USDG leg is what was spent and the
        // token leg is what arrived; for a sell it is the other way round.
        const usdg = inIsUsdg ? amountIn : filledOut;
        const qty = inIsUsdg ? filledOut : amountIn;
        // Price falls out of the two legs exactly. It is not looked up, and it
        // is null whenever either leg is missing rather than being filled in
        // from a snapshot the trade did not use.
        const price = usdg !== null && qty !== null && qty !== 0 ? usdg / qty : null;

        return {
          ts: new Date(r.ts).toISOString(),
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          version: r.version,
          action: r.intent_action,
          symbol: r.symbol || null,
          status: r.status,
          refusal_code: r.refusal_code ?? null,
          quantity: qty,
          notional_usdg: usdg,
          price_usdg: price,
          slippage_bps: r.slippage_bps,
          tx_hash: r.tx_hash ?? null,
          block_number: r.block_number === null ? null : Number(r.block_number),
          // Blocks between this trade and the newest block ARCANA has seen. Not
          // "confirmations": that would need the chain head, and this service
          // does not ask the node for it.
          blocks_since: r.block_number && r.head_block ? Number(r.head_block) - Number(r.block_number) : null,
          gas_used: r.gas_used === null ? null : Number(r.gas_used),
          gas_cost_usd: r.gas_cost_usd,
          decided_by: r.decision_action
            ? decidedBy({ action: r.decision_action, decider: r.decider, reason_code: r.reason_code })
            : null,
        };
      }),
      as_of: new Date().toISOString(),
    };
  }
}
