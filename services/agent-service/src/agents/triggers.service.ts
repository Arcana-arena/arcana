import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * What is armed on this agent, what it is watching, and what has fired.
 *
 * THE HARD PART OF THIS ENDPOINT IS WHAT IT REFUSES TO OFFER.
 *
 * The design this was built from draws a condition editor: "NAV drawdown > 8%
 * → pause agent", "ETH < 0.002 → notify + pause", "rank drops below #10 →
 * notify", with an Arm button. None of that exists on this platform. There is
 * no table to store a user-defined condition in, nothing in the tick loop that
 * would evaluate one, and no notifier that would act on it.
 *
 * A stored-but-unevaluated condition is the single worst thing this codebase
 * could ship. `risk-profile.ts` already says why, about a much smaller version
 * of the same mistake: a key that is accepted, stored, and never read is
 * "silence, in the one place where silence is indistinguishable from working".
 * An owner who arms "pause at 8% drawdown", sees it listed as ARMED, and is not
 * paused at 12% has been actively misled by a feature that was drawn before it
 * was built.
 *
 * So this returns the conditions that ARE armed and ARE evaluated — and this
 * platform has two kinds, both real, both with a fired history in the record:
 *
 *   PROTECTIVE LEVELS   per open position, checked by the guard watcher
 *                       between ticks, with triggered_at / last_refusal_at
 *   THE COST METER      per agent, checked before the decider on every tick,
 *                       recorded as a hold with reason cost_budget_exceeded
 *
 * — and it names the conditions the design asks for that nothing evaluates, as
 * unavailable rather than as an empty list waiting for an Arm button.
 */
@Injectable()
export class AgentTriggersService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async forAgent(agentId: string) {
    const agentRows = await this.db.query(
      `SELECT id::text, name, status, risk_profile FROM agents WHERE id = $1`,
      [agentId],
    );
    if (agentRows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
    const agent = agentRows[0];
    const rp = (agent.risk_profile ?? {}) as Record<string, unknown>;

    const [guards, fired, meter, meterHistory] = await Promise.all([
      this.db.query(
        `SELECT id, symbol, status,
                stop_loss::float8 AS stop_loss, stop_loss_pct::float8 AS stop_loss_fraction,
                take_profit::float8 AS take_profit, take_profit_pct::float8 AS take_profit_fraction,
                min_acceptable_pct::float8 AS min_acceptable_fraction,
                entry_price::float8 AS entry_price,
                set_at, triggered_at, triggered_side, triggered_price::float8 AS triggered_price,
                last_refusal_at, last_refusal_reason, note
           FROM position_guards
          WHERE agent_id = $1 AND subscription_id IS NULL
          ORDER BY set_at DESC`,
        [agentId],
      ),
      this.db.query(
        `SELECT symbol, status, triggered_at, triggered_side, triggered_price::float8 AS triggered_price,
                triggered_decision_id
           FROM position_guards
          WHERE agent_id = $1 AND subscription_id IS NULL AND triggered_at IS NOT NULL
          ORDER BY triggered_at DESC LIMIT 25`,
        [agentId],
      ),
      Promise.resolve(
        rp.cost_budget_monthly_pct ?? rp.costBudgetMonthlyPct ?? null,
      ),
      this.db.query(
        `SELECT id, ts, reason_code, rationale
           FROM decisions_counted
          WHERE agent_id = $1 AND reason_code = 'cost_budget_exceeded'
          ORDER BY ts DESC LIMIT 25`,
        [agentId],
      ),
    ]);

    const pct = (v: number | null) => (v === null || v === undefined ? null : Number((v * 100).toFixed(4)));

    const armed = guards
      .filter((g: Record<string, any>) => g.status === 'armed')
      .map((g: Record<string, any>) => ({
        id: Number(g.id),
        kind: 'protective_level' as const,
        symbol: g.symbol,
        // BOTH SCALES, ALWAYS. This is the platform where 0.15 was armed as
        // 15%, and a triggers screen showing one number is where it happens
        // again.
        stop_loss_price: g.stop_loss,
        stop_loss_fraction: g.stop_loss_fraction,
        stop_loss_percent: pct(g.stop_loss_fraction),
        take_profit_price: g.take_profit,
        take_profit_fraction: g.take_profit_fraction,
        take_profit_percent: pct(g.take_profit_fraction),
        entry_price: g.entry_price,
        set_at: g.set_at ? new Date(g.set_at).toISOString() : null,
        // ARMED AND HELD BACK IS ITS OWN STATE, and worse than no level.
        held_back_since: g.last_refusal_at ? new Date(g.last_refusal_at).toISOString() : null,
        held_back_because: g.last_refusal_reason ?? null,
        // WHETHER ANYTHING IS ACTUALLY WATCHING IT. The guard watcher reads
        // `WHERE g.status = 'armed' AND a.status = 'active'`, so a level on a
        // paused agent is listed as armed by its own row and is checked by
        // nobody. Saying "ARMED" without this would be the screen lying.
        watched: agent.status === 'active',
        watched_note:
          agent.status === 'active'
            ? null
            : `This agent is ${agent.status}. The guard watcher only reads levels belonging to an ACTIVE ` +
              'agent, so this level is not being checked against the price. The row still says armed and ' +
              'nothing disarmed it — it simply is not watched while the agent is not active.',
      }));

    const refused = guards
      .filter((g: Record<string, any>) => g.status === 'refused')
      .map((g: Record<string, any>) => ({
        id: Number(g.id),
        kind: 'protective_level_refused' as const,
        symbol: g.symbol,
        smallest_accepted_fraction: g.min_acceptable_fraction,
        smallest_accepted_percent: pct(g.min_acceptable_fraction),
        because: g.note ?? null,
      }));

    const budget = meter === null ? null : Number(meter);

    return {
      agent_id: agent.id,
      agent_status: agent.status,
      armed,
      refused,
      cost_meter:
        budget === null
          ? {
              armed: false,
              note:
                'No cost budget is set on this agent, so nothing meters what it spends on gas and pool ' +
                'fees. That is the default: the meter exists only for owners who ask for one. Set ' +
                'cost_budget_monthly_pct in the risk profile to arm it.',
              budget_monthly_pct: null,
            }
          : {
              armed: true,
              budget_monthly_pct: budget,
              evaluated: 'before the decider, on every tick',
              note:
                `This agent pauses itself when gas and pool fees reach ${budget}% of its capital in a ` +
                'month, or when a day’s spending projects past it. It is recorded as a hold with a ' +
                'reason, never as silence.',
            },
      fired: [
        ...fired.map((f: Record<string, any>) => ({
          at: f.triggered_at ? new Date(f.triggered_at).toISOString() : null,
          what: `protective level on ${f.symbol}`,
          outcome: `${f.triggered_side ?? 'exit'} at ${f.triggered_price ?? 'a price not recorded'}`,
          decision_id: f.triggered_decision_id ? Number(f.triggered_decision_id) : null,
        })),
        ...meterHistory.map((m: Record<string, any>) => ({
          at: m.ts ? new Date(m.ts).toISOString() : null,
          what: 'cost budget',
          outcome: m.rationale ?? 'paused, and no detail was recorded',
          decision_id: Number(m.id),
        })),
      ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))),
      /*
       * THE CONDITIONS THE DESIGN ASKS FOR THAT NOTHING EVALUATES.
       *
       * Listed by name, with what is missing, so a reader can see the shape of
       * the feature and also see that it is not there. An editor that stored
       * these would be the worst thing on this platform: a condition shown as
       * ARMED that nothing checks is indistinguishable, to its owner, from one
       * that works — right up until the drawdown it was supposed to stop.
       */
      not_available: [
        {
          condition: 'NAV drawdown from season peak',
          action: 'pause the agent',
          missing:
            'Nothing evaluates this. The drawdown is computed for display by the leaderboard series; no ' +
            'code compares it to a threshold at tick time, and there is no table to put a threshold in.',
        },
        {
          condition: 'native balance below a floor',
          action: 'notify and pause',
          missing:
            'The balance is readable (GET /v1/agents/:id/wallet/balances reports it, with a gas runway ' +
            'measured from this agent’s own fills), but nothing acts on it and there is no notifier.',
        },
        {
          condition: 'a symbol price stale for N ticks',
          action: 'exclude the symbol until it is fresh',
          missing:
            'The engine records an unavailable price per decision and refuses to act on it, which is a ' +
            'per-tick refusal rather than a standing exclusion. Nothing counts consecutive stale ticks.',
        },
        {
          condition: 'rank falls below a place',
          action: 'notify',
          missing: 'No notifier exists for a creator, and rank is computed at score time rather than at tick time.',
        },
      ],
      not_available_note:
        'These are drawn in the design and are not implemented. They are named rather than offered, because ' +
        'a condition that is stored and never evaluated looks exactly like one that works — and the moment ' +
        'it matters is the moment it was supposed to have acted.',
      as_of: new Date().toISOString(),
    };
  }
}
