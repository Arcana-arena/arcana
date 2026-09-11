import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { randomUUID } from 'node:crypto';
import { AgentsService } from './agents.service';
import { AgentWalletsService } from './agent-wallets.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { ManualDecisionDto } from './dto/manual-decision.dto';
import { ImportWalletDto } from './dto/import-wallet.dto';
import { OwnershipService } from '../auth/ownership.service';
import { DecisionClient } from '../decisions/decision.client';
import { MANDATE_TEMPLATES, MANDATE_MAX_CHARS } from './mandate-templates';
import { parsePage } from '../common/pagination';
import { ambiguousRiskKeys, unrecognisedRiskKeys } from './risk-profile';

/**
 * The agent, plus every risk_profile key nothing will read.
 *
 * ONE HELPER FOR BOTH create AND patch. Two copies of this would be two
 * answers to "did my setting take effect", and the second one to drift would
 * be the one somebody relied on.
 *
 * The field is omitted entirely when there is nothing to say, so a clean
 * profile does not carry an empty array that reads like a finding.
 */
function withRiskWarnings<T extends { riskProfile?: unknown }>(agent: T) {
  const unknown = unrecognisedRiskKeys(agent.riskProfile);
  const ambiguous = ambiguousRiskKeys(agent.riskProfile);
  if (unknown.length === 0 && ambiguous.length === 0) return agent;

  const out: Record<string, unknown> = { ...agent };
  if (unknown.length > 0) {
    out.risk_profile_unrecognised = unknown;
    out.risk_profile_note =
      unknown.length +
      ' key(s) in risk_profile are not read by the decision engine and will have no ' +
      'effect: ' + unknown.join(', ') + '. Nothing was refused and the values are stored ' +
      'as given; see docs/agents.md for the keys that are read.';
  }
  // A RETIRED KEY IS NOT AN UNREAD ONE, and folding the two together would
  // tell an owner their working stop loss does nothing. It works; it is just
  // named in a way that has already cost somebody a hundredfold.
  if (ambiguous.length > 0) {
    out.risk_profile_ambiguous = ambiguous.map((a) => a.key);
    out.risk_profile_ambiguous_note = ambiguous
      .map((a) =>
        `${a.key} is read as a FRACTION, so ${a.value} means ` +
        asPercent(a.value) +
        `. It still works; write ${a.use} instead so the number cannot be misread.`)
      .join(' ');
  }
  return out;
}

/** 0.0015 -> "0.15%". Trailing zeros trimmed so the number reads like a number. */
function asPercent(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%';
}

/**
 * Reads are public; writes require a session, and writes to a specific agent
 * require owning it.
 *
 * The public half is not an oversight — a track record anyone can inspect is
 * the product. Leaderboard, profile, passport, DNA, evolution and autopsy stay
 * open, and they keep working even when auth is misconfigured.
 */
@Controller('v1/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly agentWallets: AgentWalletsService,
    private readonly ownership: OwnershipService,
    private readonly decisions: DecisionClient,
  ) {}

  // --- 🔑 login required ----------------------------------------------------

  /**
   * The owner is the caller. A wallet with no creator profile yet is told to
   * make one rather than having one conjured for it — creating a creator is a
   * deliberate act with a handle the user chooses.
   */
  @Post()
  // Keyed by WALLET, not IP: creating agents requires a session, so there is a
  // proven identity to count against, and counting by IP would let one office
  // exhaust the allowance for everyone in it. 10/hour is generous for a person
  // and useless for a script — the active-agent cap is the real limit on how
  // many can RUN; this limits how fast rows can be written.
  @RateLimit({ limit: 10, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateAgentDto, @CurrentWallet() wallet: string) {
    const creatorId = await this.ownership.creatorIdForWallet(wallet);
    if (!creatorId) {
      throw new ForbiddenException({
        error: {
          code: 'no_creator_profile',
          message:
            'This wallet has no creator profile yet. Create one with ' +
            'POST /v1/creators before creating agents.',
          trace_id: randomUUID(),
        },
      });
    }
    const created = await this.agents.create(dto, creatorId);
    // NOTHING IS REFUSED, AND NOTHING IS SILENT. risk_profile takes any key,
    // so a typo is accepted, stored, and never read. The response names every
    // key the engine will not read rather than leaving the owner to discover
    // it from an agent that quietly has no stop loss.
    return withRiskWarnings(created);
  }

  // --- 🌐 public reads ------------------------------------------------------

  /**
   * The mandate templates an agent can be built from, with their parameters.
   *
   * Public and unauthenticated on purpose: this is the catalogue of what the
   * platform lets an agent be asked to do, and someone deciding whether to
   * sign up should be able to read it first. It contains no user data.
   *
   * Declared BEFORE `:id` — Nest matches routes in declaration order, and
   * `/v1/agents/mandate-templates` would otherwise be read as an agent id and
   * rejected by ParseUuidAllPipe.
   */
  @Get('mandate-templates')
  mandateTemplates() {
    return {
      templates: MANDATE_TEMPLATES.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        params: t.params,
      })),
      max_chars: MANDATE_MAX_CHARS,
      note:
        'A mandate is rendered by ARCANA from one of these templates and the ' +
        'parameters you choose. Free text is not accepted: no string you type ' +
        'reaches the model. Your risk limits are separate, live in risk_profile, ' +
        'and are enforced by code the model never sees.',
    };
  }

  /**
   * The public agent list — paged, searchable, filterable.
   *
   * Public and unauthenticated, because an inspectable track record is the
   * product. That is also why it needed a ceiling: an unbounded public list is
   * one request serialising the whole table from a caller who never signed in,
   * and the rate limiter bounds how OFTEN that happens rather than how much it
   * costs.
   */
  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('creator_id') creatorId?: string,
    @Query('strategy_type') strategyType?: string,
  ) {
    const { page: p, pageSize: ps, offset } = parsePage(page, pageSize);
    return this.agents.findAll({
      page: p, pageSize: ps, offset,
      q: q?.trim() || undefined,
      status: status?.trim() || undefined,
      creatorId: creatorId?.trim() || undefined,
      strategyType: strategyType?.trim() || undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.agents.findOne(id);
  }

  // --- 🔒 login + ownership -------------------------------------------------
  //
  // Ownership is asserted first, then the service applies whatever $ARCA
  // entitlement the action carries. Two questions, asked in that order, with
  // two different failures: 403 forbidden_not_owner vs 403 entitlement_denied_*.

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return withRiskWarnings(await this.agents.update(id, dto));
  }

  @Post(':id/activate')
  @UseGuards(JwtAuthGuard)
  async activate(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.activate(id);
  }

  @Post(':id/evolve')
  @RateLimit({ limit: 10, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async evolve(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: EvolveAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.evolve(id, dto);
  }

  @Post(':id/retire')
  @UseGuards(JwtAuthGuard)
  async retire(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agents.retire(id);
  }

  // --- 🔒 the agent's wallet ------------------------------------------------
  //
  // A creator's LOGIN wallet and their agents' TRADING wallets are different
  // things and are deliberately not the same. Signing in proves an identity
  // with a signature ARCANA never holds the key for. An agent wallet is an
  // address ARCANA signs from. Collapsing them would mean that signing in to
  // this platform hands it the ability to spend from the wallet you signed in
  // with, which nobody would agree to if it were stated out loud.

  /**
   * 🔒 This agent's trading wallet — its address and who can sign for it.
   *
   * Creates the derived wallet on first read. That is not a side effect worth
   * hiding: the address is a pure function of the agent id under the signer's
   * derivation, so it already IS the agent's wallet, and this only writes down
   * what was already true. There is nothing to get wrong by asking twice.
   *
   * Owner only. An address is public on chain, but which address belongs to
   * which agent is not, and publishing that map would let anyone watch a
   * specific person's positions in real time.
   */
  @Get(':id/wallet')
  @UseGuards(JwtAuthGuard)
  async wallet(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    const w = await this.agentWallets.ensure(id);
    return {
      agent_id: w.agentId,
      address: w.address,
      provenance: w.provenance,
      key_custody: w.keyCustody,
      exported_at: w.exportedAt,
      imported_at: w.importedAt,
      note:
        w.keyCustody === 'shared'
          ? 'You hold this key as well as ARCANA. You can move funds from this wallet ' +
            'without going through the platform, including while this agent has an open ' +
            'position — ARCANA reads the chain rather than assuming, and reconciles its ' +
            'record to what it finds.'
          : 'ARCANA is currently the only party that can sign for this address. You can ' +
            'take possession of the key at any time with POST /v1/agents/:id/wallet/export.',
    };
  }

  /**
   * 🔒 Take possession of the agent's private key.
   *
   * Rate limited hard, and not for load. This is the one endpoint in ARCANA
   * that returns key material, so the cost of a stolen session token is
   * bounded by how many times it can be called before anyone notices.
   */
  @Post(':id/wallet/export')
  @HttpCode(200)
  @RateLimit({ limit: 3, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async exportWallet(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    await this.agentWallets.ensure(id);
    return this.agentWallets.exportKey(id);
  }

  /**
   * 🔒 Use a wallet you already control instead of the derived one.
   *
   * THE RESPONSE SAYS PLAINLY WHAT THIS COSTS, rather than leaving it to
   * documentation nobody reads at the moment they act: ARCANA can sign
   * ANYTHING with an imported key, not only trades. The signer restricts what
   * it will build — allowlisted router, allowlisted token, capped size — but
   * that is ARCANA restricting itself, not a property of the key. So the
   * wallet must be one used for this agent and nothing else.
   *
   * The key travels in a POST body over the internal network to the signer and
   * is never written to this service's logs, this service's database, or any
   * error message.
   */
  @Post(':id/wallet/import')
  @HttpCode(200)
  @RateLimit({ limit: 3, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async importWallet(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: ImportWalletDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.agentWallets.importKey(id, dto.privateKey);
  }

  /**
   * A human submits a trade for their own agent in a human_vs_ai competition.
   *
   * This replaces `POST /internal/v1/decisions/manual` as the user-facing door.
   * The engine still exposes that internal endpoint for machines; what changed
   * is that a person no longer reaches it directly, and cannot submit for an
   * agent that is not theirs.
   */
  @Post(':id/decisions')
  @UseGuards(JwtAuthGuard)
  async submitDecision(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: ManualDecisionDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.decisions.submitManual({
      agent_id: id,
      season_id: dto.season_id,
      market_snapshot_ref: dto.market_snapshot_ref,
      timestamp: new Date().toISOString(),
      trade: {
        symbol: dto.trade.symbol ?? '',
        action: dto.trade.action,
        quantity: dto.trade.quantity ?? 0,
      },
    });
  }
}
