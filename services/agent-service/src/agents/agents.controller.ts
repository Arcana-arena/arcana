import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
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
import { AgentOverviewService } from './overview.service';
import { AgentPositionsService } from './positions.service';
import { AgentWalletsService } from './agent-wallets.service';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { ManualDecisionDto } from './dto/manual-decision.dto';
import { ImportWalletDto } from './dto/import-wallet.dto';
import { AgentsListQueryDto } from '../common/list-query.dto';
import { VERIFICATION_HEADER, provenanceFrom } from '../common/verification';
import { OwnershipService } from '../auth/ownership.service';
import { DecisionClient } from '../decisions/decision.client';
import { MANDATE_TEMPLATES, MANDATE_MAX_CHARS } from './mandate-templates';
import { AgentLifecycleService } from './lifecycle.service';
import { AgentTriggersService } from './triggers.service';
import { AgentWalletViewService } from './wallet-view.service';
import { PauseAgentDto, SetRiskDto } from './dto/lifecycle.dto';
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

/**
 * 0.0015 -> "0.15%". Trailing zeros trimmed so the number reads like a number.
 *
 * THE MULTIPLICATION IS THE WHOLE FUNCTION, and it was missing. This printed
 * `n.toFixed(4) + '%'`, so a stop of 0.0015 was described to its owner as
 * "0.0015%" — a hundredfold understatement, inside the one sentence written to
 * stop a hundredfold mistake. The warning that exists because 0.15 became 15%
 * was itself off by the same factor, in the other direction.
 *
 * Six decimals, not four: 0.000015 is a level somebody can ask for, and
 * rounding it to 0.0015% in a message about precision would repeat the fault.
 */
function asPercent(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return (n * 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + '%';
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
    private readonly overviewService: AgentOverviewService,
    private readonly positionsService: AgentPositionsService,
    private readonly lifecycle: AgentLifecycleService,
    private readonly triggersSvc: AgentTriggersService,
    private readonly walletView: AgentWalletViewService,
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
  async create(
    @Body() dto: CreateAgentDto,
    @CurrentWallet() wallet: string,
    @Headers(VERIFICATION_HEADER) verification?: string,
  ) {
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
    const created = await this.agents.create(dto, creatorId, provenanceFrom(verification));
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
  findAll(@Query() query: AgentsListQueryDto) {
    const { page: p, pageSize: ps, offset } = parsePage(
      query.page, query.page_size);
    return this.agents.findAll({
      page: p, pageSize: ps, offset,
      q: query.q?.trim() || undefined,
      status: query.status?.trim() || undefined,
      creatorId: query.creator_id?.trim() || undefined,
      strategyType: query.strategy_type?.trim() || undefined,
      provenance: query.provenance?.trim() || undefined,
    });
  }

  /**
   * 🌐 The eight figures on an agent's Overview, in one window.
   *
   * Counted in SQL rather than assembled by a page from three other reads,
   * which would have each box quietly measuring a different period.
   */
  @Get(':id/overview')
  overview(@Param('id', ParseUuidAllPipe) id: string) {
    return this.overviewService.forAgent(id);
  }

  /** 🌐 What the agent holds, what is watching it, and what it is worth. */
  @Get(':id/positions')
  positions(@Param('id', ParseUuidAllPipe) id: string) {
    return this.positionsService.forAgent(id);
  }

  /**
   * 🌐 The prompt and the raw model response behind one decision.
   *
   * PUBLIC, and that is the whole claim. "Anyone replays the record — prompt,
   * response, snapshot, fill, outcome — without a wallet and without asking the
   * creator" is either true here or it is marketing.
   */
  @Get(':id/decisions/:decisionId/evidence')
  evidence(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('decisionId') decisionId: string,
  ) {
    const n = Number(decisionId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException({
        code: 'invalid_decision_id',
        message: `decisionId must be a positive integer. Got '${decisionId.slice(0, 20)}'.`,
      });
    }
    return this.positionsService.evidence(id, n);
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

  /**
   * 🔒 Replace the risk limits on a live agent.
   *
   * NOT A FIELD ON PATCH, and not an oversight that it was missing. PATCH
   * refuses `status` because assigning it straight onto the row once activated
   * an agent past two invariants, and `riskProfile` was left out of that DTO
   * along with it — which left an owner unable to move a stop on a running
   * agent at all. "Retire it and start again" is not an answer for the one
   * number this platform has already watched somebody get wrong by a hundredfold.
   *
   * THE MANDATE IS STILL IMMUTABLE. A record is produced under a mandate;
   * risk limits are the owner's standing instruction about their own money and
   * apply from the next tick.
   *
   * The response names every key the engine will not read and every key whose
   * NAME lies about its scale — the moment somebody edits a stop is exactly
   * when a typo costs them the protection they think they just set.
   */
  @Patch(':id/risk')
  @UseGuards(JwtAuthGuard)
  async setRisk(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: SetRiskDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.lifecycle.setRisk(id, dto.riskProfile);
  }

  /**
   * 🔒 Stop deciding — and stop being watched.
   *
   * The response leads with `protection_stops: true` and names the levels left
   * unwatched, because the guard watcher only reads guards belonging to an
   * ACTIVE agent. Pausing an agent that holds an open position leaves that
   * position with no stop, and the rows go on saying "armed".
   */
  @Post(':id/pause')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async pause(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: PauseAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.lifecycle.pause(id, dto?.because ?? null);
  }

  /** 🔒 Start deciding again, and be watched again. */
  @Post(':id/resume')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async resume(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.lifecycle.resume(id);
  }

  /**
   * 🔒 What is armed on this agent, and what has fired.
   *
   * It also names the standing conditions the design asks for that NOTHING on
   * this platform evaluates. A condition stored and never checked looks exactly
   * like one that works, and the moment that matters is the moment it was
   * supposed to have acted.
   */
  @Get(':id/triggers')
  @UseGuards(JwtAuthGuard)
  async triggers(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.triggersSvc.forAgent(id);
  }

  /**
   * 🔒 What this agent's wallet holds — the money and the gas.
   *
   * The gas runway is measured from this agent's OWN recent fills rather than
   * from a platform-wide constant, and where there are too few priced
   * executions to take a median from it says so instead of offering a default.
   */
  @Get(':id/wallet/balances')
  @UseGuards(JwtAuthGuard)
  async walletBalances(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.walletView.balances(id);
  }

  /**
   * 🔒 What ARCANA did from this wallet.
   *
   * NOT the address's history: a deposit or a withdrawal the owner signed
   * themselves never passed through this platform and is not in `executions`.
   * The response says that rather than letting a short list read as complete.
   */
  @Get(':id/wallet/transactions')
  @UseGuards(JwtAuthGuard)
  async walletTransactions(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
    @Query('limit') limit?: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.walletView.transactions(id, Number(limit ?? 40));
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
