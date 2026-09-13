import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ambiguousRiskKeys, unrecognisedRiskKeys } from './risk-profile';

/**
 * The two things an owner can change on a LIVE agent, and the one they cannot.
 *
 * WHY THESE ARE NOT ON PATCH /v1/agents/:id. That endpoint refuses `status`
 * deliberately — assigning it straight onto the row once activated an agent
 * without the entitlement check and without retiring its parent, bypassing both
 * invariants activate() exists to hold. Pausing is a different act with
 * different consequences, so it gets its own door rather than a field.
 *
 * `riskProfile` was not accepted there either, and that left an owner with no
 * way at all to move a stop on a running agent. The gap mattered: the stop
 * fraction is the number this platform has already watched somebody get wrong
 * by a factor of a hundred, and "you cannot change it without retiring the
 * agent" is not an answer.
 *
 * THE MANDATE STAYS IMMUTABLE and that is not an oversight to be fixed here. A
 * record is produced under a mandate; editing it in place would leave the
 * leaderboard describing an agent that no longer exists. Risk limits are
 * different in kind — they are the owner's standing instruction to the
 * platform about their own money, they apply from the next tick, and the
 * decision log records what was in force when each decision was made.
 *
 * EVERY CHANGE IS ANSWERED WITH WHAT THE ENGINE WILL READ. The response
 * carries the same unrecognised-key and ambiguous-key warnings the create path
 * returns, because the moment somebody edits a stop is exactly the moment a
 * typo in its name costs them the protection they think they just set.
 */

/** Statuses a pause can move between. Anything else is refused by name. */
const PAUSABLE = new Set(['active']);
const RESUMABLE = new Set(['paused']);

@Injectable()
export class AgentLifecycleService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private async load(id: string) {
    const rows = await this.db.query(
      `SELECT id::text, name, status, risk_profile FROM agents WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${id} not found`);
    return rows[0] as { id: string; name: string; status: string; risk_profile: Record<string, unknown> | null };
  }

  /**
   * Replace the risk limits on an agent, live.
   *
   * A WHOLE-OBJECT REPLACE, NOT A MERGE, and the response says which keys went
   * away. A merge cannot express removal: an owner who wants to take a
   * take-profit off would have no way to say so, and would be left with a level
   * they thought they had deleted — the same silence this file's warnings exist
   * to break.
   */
  async setRisk(id: string, riskProfile: Record<string, unknown>) {
    const agent = await this.load(id);
    if (agent.status === 'retired') {
      throw new BadRequestException({
        code: 'agent_retired',
        message:
          `Agent ${id} is retired. Its limits are part of a record that has stopped moving, and ` +
          'changing them now would edit the conditions a finished track record was produced under.',
      });
    }

    const before = (agent.risk_profile ?? {}) as Record<string, unknown>;
    const removed = Object.keys(before).filter((k) => !(k in riskProfile));
    const changed = Object.keys(riskProfile).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(riskProfile[k]),
    );

    await this.db.query(`UPDATE agents SET risk_profile = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(riskProfile),
    ]);

    const unknown = unrecognisedRiskKeys(riskProfile);
    const ambiguous = ambiguousRiskKeys(riskProfile);

    return {
      agent_id: id,
      risk_profile: riskProfile,
      changed,
      removed,
      // REMOVAL IS NAMED. "I took the stop off" and "I forgot to include the
      // stop" produce the same object, and only one of them is what the owner
      // meant. Saying which keys disappeared is how they find out now rather
      // than after a position moves.
      removed_note:
        removed.length === 0
          ? null
          : `${removed.length} key(s) were in the previous profile and are not in this one, so they no ` +
            `longer apply: ${removed.join(', ')}. This endpoint replaces the profile rather than merging ` +
            'into it, because a merge cannot express taking a limit off.',
      applies_from: 'the next tick',
      applies_note:
        'Limits are read at the start of every decision. A position already open keeps the protective ' +
        'levels that were armed when it was opened — changing the fraction here does not move a level ' +
        'that is already on the chain.',
      risk_profile_unrecognised: unknown.length > 0 ? unknown : undefined,
      risk_profile_note:
        unknown.length > 0
          ? `${unknown.length} key(s) in risk_profile are not read by the decision engine and will have ` +
            `no effect: ${unknown.join(', ')}. Nothing was refused and the values are stored as given.`
          : undefined,
      risk_profile_ambiguous: ambiguous.length > 0 ? ambiguous.map((a) => a.key) : undefined,
      risk_profile_ambiguous_note:
        ambiguous.length > 0
          ? ambiguous
              .map(
                (a) =>
                  `${a.key} is read as a FRACTION, so ${a.value} means ` +
                  `${(Number(a.value) * 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}%. ` +
                  `It still works; write ${a.use} instead so the number cannot be misread.`,
              )
              .join(' ')
          : undefined,
    };
  }

  /**
   * Stop deciding. Keep protecting.
   *
   * WHAT THIS USED TO SAY, AND WHY IT CHANGED. Pausing really did turn off
   * this agent's protective exits: `ArmedGuards` in
   * services/decision-engine/internal/store/guards.go selected
   *
   *     WHERE g.status = 'armed' AND a.status = 'active'
   *
   * so the moment an agent stopped being `active` the watcher no longer saw
   * its guards. The rows still said `armed`, nothing disarmed them, and
   * nothing recorded that they had stopped being checked — a position with a
   * stop loss on it simply stopped having one. This endpoint reported that
   * honestly, which was the right thing to do about a wrong behaviour.
   *
   * The behaviour is now the one the design always claimed: a pause stops the
   * AGENT from deciding and leaves the OWNER's standing instruction about
   * their own money running. Two different things stopped being one switch.
   * Retiring is the way to stand everything down, and it takes the levels down
   * explicitly — the engine closes them with a reason on the row rather than
   * hiding them from the watcher.
   *
   * The response still names every level by symbol. "2 positions still
   * protected" and "no positions at all" are different situations, and an
   * owner is entitled to which one they are in whichever way the answer falls.
   */
  async pause(id: string, because: string | null) {
    const agent = await this.load(id);
    if (agent.status === 'paused') {
      return this.state(agent.id, 'paused', 'This agent was already paused. Nothing changed.');
    }
    if (!PAUSABLE.has(agent.status)) {
      throw new BadRequestException({
        code: 'not_pausable',
        message:
          `Agent ${id} is ${agent.status}, and only an active agent can be paused. A draft has never ` +
          'started and a retired one has stopped for good.',
      });
    }
    // WHAT KEEPS WATCHING, COUNTED BEFORE THE PAUSE TAKES EFFECT. An owner is
    // entitled to the number, not a general reassurance: "2 positions" and "no
    // positions" are completely different decisions to be making.
    const exposed = await this.db.query(
      `SELECT symbol FROM position_guards
        WHERE agent_id = $1 AND subscription_id IS NULL AND status = 'armed'`,
      [id],
    );

    await this.db.query(`UPDATE agents SET status = 'paused' WHERE id = $1`, [id]);
    return {
      ...this.state(id, 'paused', null),
      because: because ?? null,
      keeps:
        'Open positions stay open and stay yours. Subscribers keep their term and are not refunded; the ' +
        'agent decides nothing for them either.',
      // WHAT A PAUSE DOES NOT TAKE AWAY. Stated as a field rather than left to
      // the absence of a warning, because "protection continues" and "nobody
      // mentioned protection" read the same to somebody skimming.
      protection_stops: false,
      guards_still_watched: exposed.map((g: { symbol: string }) => g.symbol),
      protection_note:
        exposed.length === 0
          ? 'This agent has no armed protective level, so there is none to keep watching. If it had one, ' +
            'pausing would not take it away: a pause stops the agent from deciding and leaves your own ' +
            'stops and take-profits running.'
          : `${exposed.length} armed protective level(s) KEEP BEING CHECKED while this agent is paused ` +
            `(${exposed.map((g: { symbol: string }) => g.symbol).join(', ')}). A pause stops the agent ` +
            'from deciding; it does not cancel your standing instruction about your own position. If one ' +
            'of these levels is crossed while the pause lasts, it acts. Retire the agent instead if you ' +
            'want everything stood down.',
      stops:
        'New decisions. The agent will not open or close anything of its own accord until you resume.',
      seat:
        'The agent keeps its seat in any running competition. It will be asked for a decision and will not ' +
        'answer, which is recorded as it happens rather than counted as a decision it made.',
    };
  }

  /** Start deciding again. */
  async resume(id: string) {
    const agent = await this.load(id);
    if (agent.status === 'active') {
      return this.state(agent.id, 'active', 'This agent was already active. Nothing changed.');
    }
    if (!RESUMABLE.has(agent.status)) {
      throw new BadRequestException({
        code: 'not_resumable',
        message:
          `Agent ${id} is ${agent.status}. Only a paused agent can be resumed — a draft is started with ` +
          'POST /v1/agents/:id/activate, and a retired agent cannot come back: its record has closed and ' +
          'restarting it would attach new decisions to a finished one.',
      });
    }
    await this.db.query(`UPDATE agents SET status = 'active' WHERE id = $1`, [id]);
    const rearmed = await this.db.query(
      `SELECT symbol FROM position_guards
        WHERE agent_id = $1 AND subscription_id IS NULL AND status = 'armed'`,
      [id],
    );
    return {
      ...this.state(id, 'active', 'Deciding resumes at the next tick.'),
      // NOT "protection_resumes" — nothing was suspended. Naming it that way
      // would tell an owner that the pause they just ended had left their
      // positions bare, which is exactly the belief this change removes.
      protection_unchanged: rearmed.map((g: { symbol: string }) => g.symbol),
      protection_note:
        rearmed.length === 0
          ? 'No armed protective level exists on this agent.'
          : `${rearmed.length} armed level(s) were checked throughout the pause and still are. Resuming ` +
            'changes nothing about them; it lets the agent decide again.',
    };
  }

  private state(id: string, status: string, note: string | null) {
    return { agent_id: id, status, note, as_of: new Date().toISOString() };
  }
}
