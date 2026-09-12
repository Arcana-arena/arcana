import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Provenance } from '../common/verification';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from './agent.entity';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { EntitlementClient } from '../entitlements/entitlement.client';
import { OwnershipService } from '../auth/ownership.service';
import { Page, pageOf } from '../common/pagination';
import { MANDATE_MAX_CHARS, MandateValidationError, renderMandate } from './mandate-templates';

/**
 * How many agents one creator may have ACTIVE at once.
 *
 * ACTIVE, not total, and the distinction is the whole point. Activating a new
 * version retires its parent, so a creator who iterates on one strategy
 * accumulates retired versions while never running more than one agent. A
 * total cap would charge them for their own history and push them towards
 * abandoning versions instead of evolving them — punishing precisely the
 * behaviour the evolution feature exists to encourage.
 *
 * Drafts do not count either. A draft consumes no tick, makes no decision and
 * costs nothing to run; it is a saved intention, not an agent.
 */
export const MAX_ACTIVE_AGENTS_PER_CREATOR = 3;

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    private readonly entitlements: EntitlementClient,
    private readonly ownership: OwnershipService,
  ) {}

  /**
   * Create a draft agent for a creator.
   *
   * `creatorId` is a parameter, never a body field: it is resolved from the
   * caller's verified session by the controller. Accepting it from the request
   * was how anyone could create agents under anyone else's name.
   *
   * A new agent is ALWAYS 'draft'. Status is not settable here — see activate().
   */
  async create(
    dto: CreateAgentDto,
    creatorId: string,
    provenance: Provenance = 'live',
  ): Promise<Agent> {
    const m = this.buildMandate(dto.mandate, dto.mandateTemplate, dto.mandateParams);

    const latest = await this.agents.findOne({
      where: { creatorId, name: dto.name },
      order: { version: 'DESC' },
    });
    const version = latest ? latest.version + 1 : 1;

    const agent = this.agents.create({
      creatorId,
      name: dto.name,
      version,
      parentAgentId: dto.parentAgentId ?? null,
      // A MANDATE IMPLIES A MODEL. The mandate is prose addressed to an LLM;
      // the deterministic strategies never read it. An agent built from a
      // template and left with no strategy_type therefore ran momentum or
      // mean-reversion while its mandate sat in the row doing nothing, and
      // nothing anywhere said so -- the agent simply was not what its own
      // record described. An explicit strategyType still wins, because asking
      // for a deterministic strategy is a real thing to want.
      strategyType: dto.strategyType ?? (m.mandate ? 'llm' : null),
      riskProfile: dto.riskProfile ? JSON.parse(dto.riskProfile) : {},
      assetUniverse: dto.assetUniverse,
      mandate: m.mandate,
      mandateTemplate: m.template,
      mandateParams: m.params,
      mandateSource: m.source,
      status: 'draft',
      // Recorded at creation and frozen there by a database trigger. See
      // common/verification.ts for why this is not inferred from the name.
      provenance,
    });
    return this.agents.save(agent);
  }

  /**
   * Two ways to say what an agent is for, and they are exclusive.
   *
   * A TEMPLATE renders a sentence from a closed set of enumerations and numeric
   * ranges; no string the user typed reaches the model. FREE TEXT is the user's
   * own words, bounded by length and fenced structurally in the prompt.
   *
   * Supplying both is refused rather than resolved. Picking one would mean an
   * agent pursues something its owner can see they did not choose, and the
   * whole point of recording mandate_source is that the answer to "where did
   * this come from" is never a guess.
   */
  private buildMandate(
    free: string | undefined,
    templateId: string | undefined,
    rawParams: Record<string, unknown> | undefined,
  ): {
    mandate: string | null;
    template: string | null;
    params: Record<string, string | number> | null;
    source: 'template' | 'free' | null;
  } {
    const freeText = free?.trim();

    if (freeText && templateId) {
      throw new BadRequestException({
        code: 'mandate_and_template',
        message:
          'Supply either `mandate` (your own words) or `mandateTemplate` (a ' +
          'parameterised form), not both. They are two answers to the same ' +
          'question and there is no sensible way to combine them.',
      });
    }

    if (freeText) {
      if (rawParams && Object.keys(rawParams).length > 0) {
        throw new BadRequestException({
          code: 'mandate_params_without_template',
          message:
            'mandateParams only mean something alongside mandateTemplate. With a ' +
            'free-text mandate there is nothing to interpret them against.',
        });
      }
      if (freeText.length > MANDATE_MAX_CHARS) {
        // Refused, never truncated. A silently shortened mandate is one the
        // owner never sees the real version of, and they would be judging an
        // agent on instructions they did not write.
        throw new BadRequestException({
          code: 'mandate_too_long',
          message:
            `The mandate is ${freeText.length} characters and the limit is ` +
            `${MANDATE_MAX_CHARS}. The limit is about inference cost, not safety: ` +
            'this text is sent on every decision, so a longer one is re-read six ' +
            'times a day for as long as the agent runs.',
        });
      }
      return { mandate: freeText, template: null, params: null, source: 'free' };
    }

    if (!templateId) {
      if (rawParams && Object.keys(rawParams).length > 0) {
        throw new BadRequestException({
          code: 'mandate_params_without_template',
          message:
            'mandateParams was supplied without mandateTemplate. There is no ' +
            'template to interpret them against, so they would have been ignored.',
        });
      }
      return { mandate: null, template: null, params: null, source: null };
    }

    try {
      const { mandate, params } = renderMandate(templateId, rawParams);
      return { mandate, template: templateId, params, source: 'template' };
    } catch (e) {
      if (e instanceof MandateValidationError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }

  /**
   * The public agent list — paged, searchable, filterable.
   *
   * It returned every row, unbounded, to anyone. Fine at seven agents; phase 12
   * opens creation to users, and an unbounded public list is one request
   * serialising the whole table from a caller who never signed in.
   *
   * SEARCH IS A PREFIX-AND-CONTAINS MATCH ON NAME, deliberately dull. A
   * full-text index would be the right answer at a scale this is nowhere near,
   * and adding one now would be a second thing to keep in step with the table
   * for no measurable gain. ILIKE with an escaped pattern is honest about what
   * it is.
   *
   * The parameter is escaped rather than interpolated: `%` and `_` are
   * wildcards in LIKE, so a user searching for a name containing an underscore
   * would otherwise get a different query from the one they asked for — and a
   * search for `%` would return everything, which is the unbounded list coming
   * back through the front door.
   */
  async findAll(opts: {
    page: number;
    pageSize: number;
    offset: number;
    q?: string;
    status?: string;
    creatorId?: string;
    strategyType?: string;
    provenance?: string;
  }): Promise<Page<Agent>> {
    const qb = this.agents.createQueryBuilder('a');

    if (opts.q) {
      const pattern = `%${opts.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      qb.andWhere("a.name ILIKE :pattern ESCAPE '\\'", { pattern });
    }
    if (opts.status) {
      if (!['draft', 'active', 'retired'].includes(opts.status)) {
        throw new BadRequestException({
          code: 'invalid_status_filter',
          message: `status must be one of: draft, active, retired. Got '${opts.status.slice(0, 20)}'.`,
        });
      }
      qb.andWhere('a.status = :status', { status: opts.status });
    }
    if (opts.creatorId) qb.andWhere('a.creator_id = :creatorId', { creatorId: opts.creatorId });
    if (opts.strategyType) {
      qb.andWhere('a.strategy_type = :strategyType', { strategyType: opts.strategyType });
    }
    // PROVENANCE, AS A FILTER AND NOT AS A DEFAULT.
    //
    // Migration 0042 records whether a row was created by a person or by a
    // verification run, and the column is immutable in both directions. Until
    // now nothing could ask: a caller counting agents got the artefacts mixed in
    // with the real ones, and "1,284 agents" would quietly include fixtures
    // nobody meant to advertise.
    //
    // The DEFAULT IS DELIBERATELY UNCHANGED. Filtering artefacts out by default
    // would silently alter what every existing caller already receives, and it
    // would make the artefacts hard to find for the sweeps that exist to remove
    // them. A caller that wants only real agents now asks for them.
    if (opts.provenance) {
      if (!['live', 'verification'].includes(opts.provenance)) {
        throw new BadRequestException({
          code: 'invalid_provenance_filter',
          message:
            `provenance must be one of: live, verification. Got '${opts.provenance.slice(0, 20)}'. ` +
            'The vocabulary is closed by the CHECK constraint on agents.provenance (migration 0042).',
        });
      }
      qb.andWhere('a.provenance = :provenance', { provenance: opts.provenance });
    }

    // Ordered by created_at DESC then id, because created_at is not unique and
    // an unstable sort makes paging skip and repeat rows across pages — a bug
    // that only appears at the boundary between two pages and is therefore
    // never noticed in a list short enough to fit on one.
    const [items, total] = await qb
      .orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip(opts.offset)
      .take(opts.pageSize)
      .getManyAndCount();

    return pageOf(items, total, opts.page, opts.pageSize);
  }

  async findOne(id: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id } });
    if (!agent) {
      throw new NotFoundException(`Agent ${id} not found`);
    }
    return agent;
  }

  /**
   * PATCH /agents/:id — edit an agent's descriptive fields.
   *
   * Status is NOT among them, and that is the fix for a real hole rather than a
   * stylistic choice. `UpdateAgentDto` used to accept `status`, and this method
   * used to `Object.assign` it straight onto the row. A caller could therefore
   * PATCH `{"status":"active"}` and get an active agent while skipping BOTH
   * invariants that activate() exists to hold: the $ARCA entitlement check, and
   * the retirement of the parent version. One request, two invariants gone.
   *
   * Activation now has exactly one door — activate(). Retirement has exactly
   * one — retire().
   */
  async update(id: string, dto: UpdateAgentDto): Promise<Agent> {
    const agent = await this.findOne(id);
    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.strategyType !== undefined) agent.strategyType = dto.strategyType;

    if (dto.mandate !== undefined || dto.mandateTemplate !== undefined || dto.mandateParams !== undefined) {
      // DRAFTS ONLY.
      //
      // An active agent's mandate is part of the conditions its track record
      // was produced under. Editing it in place would leave the leaderboard
      // making a claim about an agent that no longer exists, and there would be
      // nothing in the record to show the swap happened. Changing an active
      // agent's intent is what evolve() is for: it creates a version, and the
      // boundary is visible to anyone reading the history.
      if (agent.status !== 'draft') {
        throw new BadRequestException({
          code: 'mandate_immutable_once_active',
          message:
            `Agent ${id} is ${agent.status}, and a mandate can only be edited while an agent ` +
            'is a draft. Its recorded performance was produced under the current mandate, so ' +
            'changing it in place would misdescribe that record. Use POST /v1/agents/:id/evolve ' +
            'to create a new version with a different mandate.',
        });
      }
      // SWITCHING BETWEEN THE TWO FORMS IS ALLOWED ON A DRAFT, and the old
      // form must not leak into the new one. Falling back to the stored
      // template while the caller supplies free text would send both into
      // buildMandate and trip its exclusivity check, reporting a conflict the
      // caller did not create.
      const switchingToFree = dto.mandate !== undefined && dto.mandate.trim() !== '';
      const m = this.buildMandate(
        dto.mandate ?? (switchingToFree ? undefined : agent.mandateSource === 'free' ? agent.mandate ?? undefined : undefined),
        switchingToFree ? undefined : dto.mandateTemplate ?? agent.mandateTemplate ?? undefined,
        switchingToFree ? undefined : dto.mandateParams ?? agent.mandateParams ?? undefined,
      );
      agent.mandate = m.mandate;
      agent.mandateTemplate = m.template;
      agent.mandateParams = m.params;
      agent.mandateSource = m.source;
    }

    return this.agents.save(agent);
  }

  /**
   * POST /agents/:id/activate — transition to active.
   *
   * Two separate checks run before this succeeds, in this order, and they
   * answer different questions:
   *
   *   1. ownership (the controller) — is the caller this agent's owner? 403 if not.
   *   2. entitlement (here)         — does that owner hold enough $ARCA? 403 if not.
   *
   * Because check 1 has already passed, the wallet the entitlement is charged
   * against is now provably the caller's own. Before auth existed it was merely
   * the agent's owner's wallet, which meant a stranger evolving someone else's
   * agent spent the victim's entitlement. That is now correct by construction,
   * not by luck.
   *
   * On the entitlement itself: the check is real, but the token has not
   * launched, so arca-service passes every check WITHOUT reading a balance and
   * says so in its response. The gate is wired, not yet enforcing. See
   * docs/arca-entitlements.md.
   *
   * Activating a version RETIRES its parent (see retireParent).
   */
  async activate(id: string): Promise<Agent> {
    const agent = await this.findOne(id);
    if (agent.status === 'retired') {
      throw new BadRequestException('Retired agents cannot be activated');
    }
    if (agent.status === 'active') return agent;

    const wallet = await this.entitlements.walletForCreator(agent.creatorId);
    await this.entitlements.require('create', wallet, `activate agent ${agent.id}`);

    // THE CAP, AND WHY IT IS INSIDE A TRANSACTION.
    //
    // Counting and then writing is a race: two activations arriving together
    // both read 2, both decide there is room, and the creator ends with 4.
    // Rare, entirely reachable from a double-clicked button, and it produces a
    // state no later request can explain. So the creator's active rows are
    // locked for the duration and the count is taken under that lock.
    //
    // The parent is EXCLUDED from the count. Activating a version retires its
    // parent in the same transaction, so counting it would mean a creator at
    // the cap cannot evolve — the one operation that leaves the total exactly
    // where it was. Succession must never be blocked by a limit on
    // simultaneity.
    return this.agents.manager.transaction(async (tx) => {
      const active: Array<{ id: string }> = await tx.query(
        `SELECT id FROM agents
          WHERE creator_id = $1 AND status = 'active' AND id <> $2
          ORDER BY id
          FOR UPDATE`,
        [agent.creatorId, agent.id],
      );

      const others = active.filter((r) => r.id !== agent.parentAgentId);
      if (others.length >= MAX_ACTIVE_AGENTS_PER_CREATOR) {
        throw new BadRequestException({
          code: 'active_agent_limit_reached',
          message:
            `This creator already has ${others.length} active agents, and the limit is ` +
            `${MAX_ACTIVE_AGENTS_PER_CREATOR}. Retire one with POST /v1/agents/:id/retire, ` +
            'or evolve an existing agent instead — activating a new version retires the ' +
            'version it replaces, so it does not consume another slot. Retired and draft ' +
            'agents do not count towards this limit.',
          active_agents: others.map((r) => r.id),
          limit: MAX_ACTIVE_AGENTS_PER_CREATOR,
        });
      }

      await tx.query(`UPDATE agents SET status = 'active' WHERE id = $1`, [agent.id]);
      if (agent.parentAgentId) {
        await this.retireParent(agent.parentAgentId, agent.id, tx);
      }
      agent.status = 'active';
      return agent;
    });
  }

  /**
   * POST /agents/:id/retire — the owner stands their agent down.
   *
   * This exists because closing the PATCH hole removed the only way to retire
   * an agent, and retirement is a real product action rather than an accident
   * of a writable column. No $ARCA entitlement applies: withdrawing from
   * competition is not a privilege anyone needs to hold tokens to exercise.
   *
   * Like retireParent, this hands back the agent's seat in any running
   * competition so the scheduler stops calling it every tick.
   */
  async retire(id: string): Promise<Agent> {
    const agent = await this.findOne(id);
    if (agent.status === 'retired') return agent;

    agent.status = 'retired';
    const saved = await this.agents.save(agent);

    await this.agents.manager.query(
      `UPDATE competitions
          SET participant_ids = array_remove(participant_ids, $1::uuid)
        WHERE status <> 'completed'
          AND $1::uuid = ANY(participant_ids)`,
      [id],
    );

    return saved;
  }

  /**
   * Succession: when a version goes live, the version it replaces steps down.
   *
   * Why retire rather than let both compete: the leaderboard is the platform's
   * reputation surface, and a creator running v1..v5 side by side would occupy
   * five places with five variations of one idea. "V1 → V2 → V3" is a
   * succession, not a family.
   *
   * Nothing is erased. The parent's row, decisions, portfolio snapshots and
   * score history are append-only and untouched; it keeps its Passport and its
   * badges, and its record simply closes at this point. That closure is also
   * what makes the before/after comparison meaningful — "before" becomes a
   * finished period rather than a moving target.
   *
   * The cost, stated plainly: the two versions then never trade the same ticks,
   * so no comparison between them can fully separate the agent from its market.
   * See docs/agent-evolution.md.
   */
  private async retireParent(
    parentId: string,
    childId: string,
    // Runs in the caller's transaction when there is one, so the parent's
    // retirement and the child's activation are one atomic step. If they were
    // separate, a failure between them would leave a creator over the cap with
    // both versions active — the exact state the cap exists to prevent.
    tx?: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  ): Promise<void> {
    const db = tx ?? this.agents.manager;
    const parent = await this.agents.findOne({ where: { id: parentId } });
    if (!parent || parent.status === 'retired') return;

    await db.query(`UPDATE agents SET status = 'retired' WHERE id = $1`, [parentId]);

    // Hand over the parent's seat in any competition still running. Without
    // this the scheduler keeps calling a retired agent every tick and logs a
    // failure every minute forever — the kind of permanent noise that teaches
    // people to stop reading the journal.
    await db.query(
      `UPDATE competitions
          SET participant_ids = array_replace(participant_ids, $1::uuid, $2::uuid)
        WHERE status <> 'completed'
          AND $1::uuid = ANY(participant_ids)
          AND NOT ($2::uuid = ANY(participant_ids))`,
      [parentId, childId],
    );
    // If the child was already a participant, just drop the parent's seat.
    await db.query(
      `UPDATE competitions
          SET participant_ids = array_remove(participant_ids, $1::uuid)
        WHERE status <> 'completed'
          AND $1::uuid = ANY(participant_ids)`,
      [parentId],
    );
  }

  /**
   * POST /agents/:id/evolve — create a new version snapshotting this agent's config.
   *
   * Gated on the $ARCA EVOLVE entitlement (§2.7). Checked here, at creation,
   * rather than at activation: evolving is the act the entitlement covers, and
   * a creator should learn they lack the right before building a version, not
   * after.
   *
   * Ownership was already established by the controller, so the child inherits
   * the parent's creator — which is the caller's own creator.
   */
  async evolve(id: string, overrides: EvolveAgentDto): Promise<Agent> {
    const agent = await this.findOne(id);

    const wallet = await this.entitlements.walletForCreator(agent.creatorId);
    await this.entitlements.require('evolve', wallet, `evolve agent ${agent.id}`);

    // The mandate follows the same inherit-unless-overridden rule as every
    // other field. Supplying only `mandateParams` re-renders the PARENT'S
    // template with new values, which is the common case — the same idea,
    // tuned — and means a caller does not have to restate a template id just
    // to change one number.
    const template = overrides.mandateTemplate ?? agent.mandateTemplate ?? undefined;
    const params = overrides.mandateParams ?? agent.mandateParams ?? undefined;

    return this.create(
      {
        name: agent.name,
        strategyType: overrides.strategyType ?? agent.strategyType ?? undefined,
        riskProfile: overrides.riskProfile ?? JSON.stringify(agent.riskProfile),
        assetUniverse: overrides.assetUniverse ?? agent.assetUniverse,
        parentAgentId: agent.id,
        mandateTemplate: template,
        // When the template is inherited but the params are not stated, the
        // parent's params come through as-is; renderMandate validates them
        // again rather than trusting a stored row, so a template whose ranges
        // tightened since cannot quietly keep producing an out-of-range agent.
        mandateParams: template ? (params as Record<string, unknown> | undefined) : undefined,
      },
      agent.creatorId,
    );
  }
}
