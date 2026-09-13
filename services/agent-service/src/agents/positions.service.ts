import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { positionsOf } from '../common/positions';
import { MarketPriceClient } from '../series/market-price.client';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { COMMITMENT_EXPLAINED, isPrivate } from '../intelligence/intelligence';

/**
 * What an agent holds, what is watching it, and what it is worth now.
 *
 * THREE FACTS THAT ARE EASY TO BLUR, KEPT APART:
 *
 *   what is HELD      the quantities in the latest portfolio snapshot
 *   what it COST      the entry price, which only exists where a guard recorded
 *                     one — the record does not pair a buy to the position it
 *                     opened, so for anything else the entry is UNKNOWN and is
 *                     reported as unknown rather than back-solved
 *   what is WATCHING  an armed guard, a refused one, or nothing at all
 *
 * A POSITION WITH NO GUARD IS THE POINT OF THIS ENDPOINT. It is not an absence
 * to leave out of the list: it is an open position that nothing is watching
 * between ticks, and it carries the smallest level the pool would have accepted
 * so the reader can see what was possible rather than only what was done.
 *
 * PRICES COME FROM THE SNAPSHOT THE AGENT LAST SAW, not from a live quote. This
 * service does not call the market. A value computed against a price the agent
 * never acted on would be a number that changes while nothing happened, and the
 * timestamp of the snapshot is returned so the reader knows how old it is.
 */
@Injectable()
export class AgentPositionsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketPrices: MarketPriceClient,
    private readonly intelligence: IntelligenceService,
  ) {}

  async forAgent(agentId: string) {
    const agent = await this.db.query(`SELECT id, name FROM agents WHERE id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);

    const snap = await this.db.query(
      `SELECT ps.ts, ps.nav::float8 AS nav, ps.cash::float8 AS cash, ps.holdings, p.season_id
         FROM portfolio_snapshots ps
         JOIN portfolios p ON p.id = ps.portfolio_id
        WHERE p.agent_id = $1
        ORDER BY ps.ts DESC LIMIT 1`,
      [agentId],
    );

    // The market snapshot the agent's most recent decision cited. The prices
    // are NOT in this table — market_snapshots records the reference and the
    // content hash, and the quotes themselves live in the object store behind
    // MarketPriceClient. Reading ms.prices threw "column does not exist" the
    // first time this endpoint was called, which is where a wrong column name
    // belongs.
    const priced = await this.db.query(
      `SELECT ms.ref, ms.tick_time
         FROM decisions_counted d
         JOIN market_snapshots ms ON ms.ref = d.market_snapshot_ref
        WHERE d.agent_id = $1
        ORDER BY d.ts DESC LIMIT 1`,
      [agentId],
    );

    const guards = await this.db.query(
      `SELECT symbol, status,
              entry_price::float8 AS entry_price,
              stop_loss::float8 AS stop_loss,
              take_profit::float8 AS take_profit,
              stop_loss_pct::float8 AS stop_loss_fraction,
              take_profit_pct::float8 AS take_profit_fraction,
              min_acceptable_pct::float8 AS min_acceptable_fraction,
              set_at, last_refusal_at, last_refusal_reason, note
         FROM position_guards
        WHERE agent_id = $1 AND subscription_id IS NULL
        ORDER BY set_at DESC`,
      [agentId],
    );

    const pct = (v: number | null) => (v === null || v === undefined ? null : Number((v * 100).toFixed(4)));
    const round = (v: number | null | undefined, dp: number) =>
      v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp));

    const priceRef: string | null = priced[0]?.ref ?? null;
    const priceAt = priced[0]?.tick_time ? new Date(priced[0].tick_time).toISOString() : null;

    // AND THE QUOTES COME FROM THE OBJECT STORE, through the same client the
    // decision log uses. When it cannot be reached the prices are UNKNOWN and
    // say so — they are not silently absent, and they are certainly not zero.
    let prices: Record<string, number> = {};
    let priceAvailable = true;
    let priceReason: string | null = null;
    if (priceRef) {
      const lookup = await this.marketPrices.lookup([priceRef]);
      priceAvailable = lookup?.available !== false;
      priceReason = lookup?.reason ?? null;
      prices = (lookup?.snapshots?.[priceRef]?.prices as Record<string, number>) ?? {};
    } else {
      priceAvailable = false;
      priceReason = 'This agent has no decision citing a market snapshot, so there is no price to read.';
    }

    const held = snap.length > 0 ? positionsOf(snap[0].holdings as Record<string, number>) : [];

    const bySymbol = new Map<string, any>();
    for (const g of guards) {
      // The newest guard per symbol wins; the query is already ordered by
      // set_at DESC, so the first one seen is the current one.
      if (!bySymbol.has(g.symbol)) bySymbol.set(g.symbol, g);
    }

    const open = held.map(([symbol, qty]) => {
      const g = bySymbol.get(symbol) ?? null;
      const price = typeof prices[symbol] === 'number' ? prices[symbol] : null;
      const entry = g?.entry_price ?? null;
      const value = price !== null ? qty * price : null;
      // P&L only where BOTH an entry and a price exist. Anything else would be
      // a number invented from one half of a subtraction.
      const pnl = entry !== null && price !== null ? (price - entry) * qty : null;
      const pnlPct = entry !== null && price !== null && entry !== 0 ? ((price - entry) / entry) * 100 : null;

      const armed = g && g.status === 'armed';
      const refused = g && g.status === 'refused';

      return {
        symbol,
        quantity: round(qty, 8),
        entry_price: round(entry, 6),
        entry_known: entry !== null,
        entry_note: entry === null
          ? 'No guard recorded an entry price for this position, and the record does not pair a buy ' +
            'to the position it opened. The entry is unknown rather than reconstructed.'
          : null,
        price: round(price, 6),
        // THREE DIFFERENT ABSENCES, KEPT APART. The market could not be
        // reached; the snapshot was read and has no quote for this symbol; or
        // there is a price. Collapsing the first two into one would hide an
        // outage behind a missing symbol.
        price_status: !priceAvailable ? 'unavailable' : price === null ? 'symbol_not_in_snapshot' : 'from_snapshot',
        price_note: !priceAvailable
          ? `The market snapshot could not be read${priceReason ? `: ${priceReason}` : ''}. This is not a price of zero.`
          : price === null
            ? 'The snapshot this agent last acted on carries no quote for this symbol.'
            : 'The price in the snapshot the agent last acted on — not a live quote.',
        value: round(value, 2),
        pnl: round(pnl, 2),
        pnl_pct: round(pnlPct, 4),
        protection: armed
          ? {
              state: 'armed',
              // BOTH SCALES, ALWAYS. 0.15 and 0.15% are not the same number,
              // and this is the surface where that mistake costs money.
              stop_loss: round(g.stop_loss, 6),
              stop_loss_fraction: g.stop_loss_fraction,
              stop_loss_percent: pct(g.stop_loss_fraction),
              take_profit: round(g.take_profit, 6),
              take_profit_fraction: g.take_profit_fraction,
              take_profit_percent: pct(g.take_profit_fraction),
              set_at: g.set_at ? new Date(g.set_at).toISOString() : null,
              held_back_since: g.last_refusal_at ? new Date(g.last_refusal_at).toISOString() : null,
              held_back_because: g.last_refusal_reason ?? null,
            }
          : refused
            ? {
                state: 'refused',
                smallest_accepted_fraction: g.min_acceptable_fraction,
                smallest_accepted_percent: pct(g.min_acceptable_fraction),
                because: g.note ?? null,
              }
            : {
                state: 'none',
                because: 'No protective level has been asked for on this symbol. Nothing is watching ' +
                  'it between ticks.',
              },
      };
    });

    // CLOSED POSITIONS, from the guards that ended. A guard whose status is no
    // longer armed or refused is one the engine closed out, and it is the only
    // record this platform keeps of a position that finished.
    const closed = guards
      .filter((g: any) => g.status !== 'armed' && g.status !== 'refused')
      .map((g: any) => ({
        symbol: g.symbol,
        status: g.status,
        entry_price: round(g.entry_price, 6),
        stop_loss: round(g.stop_loss, 6),
        stop_loss_percent: pct(g.stop_loss_fraction),
        take_profit: round(g.take_profit, 6),
        take_profit_percent: pct(g.take_profit_fraction),
        set_at: g.set_at ? new Date(g.set_at).toISOString() : null,
      }));

    // PROTECTIVE LEVELS ARE RISK RULES. A private agent's holdings, values and
    // P&L stay public — they are what it did — but the level each stop sits at
    // is what its owner told it, and is withheld. Which positions are watched is
    // still stated, so "no protection" and "protection you cannot see" never
    // look alike.
    const vis = await this.intelligence.visibilityOf(agentId);
    const privateAgent = isPrivate(vis?.visibility);
    const LEVELS_WITHHELD =
      'This agent keeps its risk rules private, so the level is not shown. Every exit a level takes is a ' +
      'public decision.';
    if (privateAgent) {
      for (const o of open as Array<Record<string, any>>) {
        if (o.protection?.state === 'armed') {
          o.protection = {
            state: 'armed',
            levels: 'withheld',
            held_back_since: o.protection.held_back_since ?? null,
            note: LEVELS_WITHHELD,
          };
        } else if (o.protection?.state === 'refused') {
          o.protection = { state: 'refused', levels: 'withheld', note: LEVELS_WITHHELD };
        }
      }
    }
    const closedOut = privateAgent
      ? closed.map((c: Record<string, any>) => ({
          symbol: c.symbol,
          status: c.status,
          entry_price: c.entry_price,
          set_at: c.set_at,
          levels: 'withheld',
        }))
      : closed;

    return {
      agent_id: agentId,
      visibility: privateAgent ? 'private' : 'public',
      as_of: snap.length > 0 ? new Date(snap[0].ts).toISOString() : null,
      nav: round(snap[0]?.nav, 2),
      cash: round(snap[0]?.cash, 2),
      prices: {
        snapshot_ref: priceRef,
        tick_time: priceAt,
        available: priceAvailable,
        reason: priceReason,
        source: 'the market snapshot the agent last acted on, not a live quote',
      },
      open,
      closed: closedOut,
      note: open.length === 0
        ? 'This agent holds no position. That is a recorded all-cash book, not a missing reading.'
        : null,
    };
  }

  /**
   * The prompt and the raw model response behind one decision.
   *
   * Content-addressed: `decisions` stores the hashes, `decision_evidence`
   * stores the bodies. Separate from the decision list because these are large
   * and almost nobody reading a table wants them — but anybody CAN have them,
   * which is the whole claim this platform makes.
   */
  async evidence(agentId: string, decisionId: number) {
    const vis = await this.intelligence.visibilityOf(agentId);
    if (!vis) throw new NotFoundException(`Agent ${agentId} not found`);
    const opened = isPrivate(vis.visibility)
      ? (await this.intelligence.openedDecisions(agentId)).has(decisionId)
      : false;

    // THE DECISION ITSELF IS PUBLIC FOR EVERY AGENT, and so is its seal.
    const head = await this.db.query(
      `SELECT d.id, d.ts, d.action, d.symbol, d.decider, d.reason_code,
              d.commitment, d.commitment_scheme, d.market_snapshot_ref
         FROM decisions_counted d
        WHERE d.id = $1 AND d.agent_id = $2`,
      [decisionId, agentId],
    );
    if (head.length === 0) throw new NotFoundException(`Decision ${decisionId} not found for this agent`);
    const h = head[0];
    const commitment = h.commitment ? String(h.commitment).trim() : null;
    const decision = {
      decision_id: Number(h.id),
      ts: new Date(h.ts).toISOString(),
      action: h.action,
      symbol: h.symbol || null,
      decider: h.decider ?? null,
      reason_code: h.reason_code ?? null,
      market_snapshot_ref: h.market_snapshot_ref ?? null,
      commitment: {
        value: commitment,
        scheme: h.commitment_scheme ?? null,
        explained: commitment
          ? COMMITMENT_EXPLAINED
          : 'This decision has no commitment: it was recorded before commitments existed, or could not be ' +
            'sealed when it was recorded. None is ever added afterwards.',
      },
    };

    // A PRIVATE, UNOPENED DECISION: the bodies are not even read. What cannot
    // be loaded cannot be leaked by a later edit to the shape below.
    if (isPrivate(vis.visibility) && !opened) {
      return {
        ...decision,
        intelligence: {
          visibility: 'private' as const,
          opened: false,
          withheld: ['rationale', 'thesis', 'model and version', 'prompt', 'raw model response'],
          note:
            'The creator keeps the reasoning behind this decision private. The decision, its execution and ' +
            'its outcome are public, and the commitment above proves the hidden reasoning was fixed when the ' +
            'decision was made. The creator can open it; if they do, that is recorded permanently.',
        },
        rationale: null,
        thesis: null,
        model: null,
        prompt: null,
        response: null,
        verification: null,
      };
    }

    const rows = await this.db.query(
      `SELECT d.id, d.ts, d.action, d.symbol, d.rationale, d.thesis,
              d.provider, d.model, d.model_version, d.params,
              d.prompt_hash, d.response_hash, d.system_prompt_hash, d.market_snapshot_ref,
              pe.body AS prompt_body, pe.bytes AS prompt_bytes,
              re.body AS response_body, re.bytes AS response_bytes
         -- decisions_counted, NOT the raw table. The view excludes rows
         -- marked as measurement artefacts, and artefact-verify fails any
         -- service that reads around it — correctly: an endpoint that serves
         -- evidence for a row every other surface refuses to count would be
         -- publishing a decision the platform does not consider real.
         FROM decisions_counted d
         LEFT JOIN decision_evidence pe ON pe.hash = d.prompt_hash
         LEFT JOIN decision_evidence re ON re.hash = d.response_hash
        WHERE d.id = $1 AND d.agent_id = $2`,
      [decisionId, agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Decision ${decisionId} not found for this agent`);
    const r = rows[0];

    // Readable, so the manifest may be shown and checked: every check the
    // service ran, not a bare "verified".
    const verification = commitment ? await this.intelligence.verifyCommitment(agentId, decisionId) : null;

    return {
      ...decision,
      intelligence: {
        visibility: vis.visibility,
        opened,
        withheld: [] as string[],
        note: opened
          ? 'This agent is private, and its creator opened the reasoning behind this decision. The opening is ' +
            'on the agent’s public record of disclosures.'
          : null,
      },
      verification,
      system_prompt: { hash: r.system_prompt_hash ? String(r.system_prompt_hash).trim() : null },
      rationale: r.rationale ?? null,
      thesis: r.thesis ?? null,
      model: {
        provider: r.provider ?? null,
        model: r.model ?? null,
        model_version: r.model_version ?? null,
        params: r.params ?? null,
        note: r.model
          ? null
          : 'No model is recorded on this decision: it was produced by a deterministic strategy or ' +
            'by the platform, not by a language model.',
      },
      prompt: {
        hash: r.prompt_hash ?? null,
        body: r.prompt_body ?? null,
        bytes: r.prompt_bytes === null || r.prompt_bytes === undefined ? null : Number(r.prompt_bytes),
        // A HASH WITH NO BODY IS A DIFFERENT FACT FROM NO HASH AT ALL. The
        // first means the evidence was recorded and has since been pruned; the
        // second means this decision never had one.
        note: r.prompt_hash && !r.prompt_body
          ? 'The prompt was recorded and its body is no longer in the evidence store.'
          : !r.prompt_hash
            ? 'This decision was not produced from a prompt.'
            : null,
      },
      response: {
        hash: r.response_hash ?? null,
        body: r.response_body ?? null,
        bytes: r.response_bytes === null || r.response_bytes === undefined ? null : Number(r.response_bytes),
        note: r.response_hash && !r.response_body
          ? 'The response was recorded and its body is no longer in the evidence store.'
          : !r.response_hash
            ? 'This decision has no model response behind it.'
            : null,
      },
      market_snapshot_ref: r.market_snapshot_ref ?? null,
    };
  }
}
