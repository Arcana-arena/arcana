/**
 * Publishing a claim, and reading claims back.
 *
 * Nothing here computes performance. Creating a thesis writes down what was
 * claimed and how it will be judged; ThesisResolutionService does the judging,
 * later, from data this file never touches.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketIndexService } from '../market/market-index.service';
import { CreateThesisDto } from './dto/create-thesis.dto';
import { CreateArticleDto, UpdateArticleDto } from './dto/create-article.dto';

/** 24 hours and 365 days, the same bounds the database constraint enforces. */
const MIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class ThesesService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly marketIndex: MarketIndexService,
  ) {}

  // ----------------------------------------------------------------- create

  /**
   * Publish a thesis against an agent the caller owns.
   *
   * WHAT IS CHECKED HERE AND WHY EACH ONE EXISTS:
   *  - the agent is ACTIVE. A thesis bound to a draft would be measured over a
   *    portfolio that has never traded, and one bound to a retired agent is a
   *    claim nobody intends to test.
   *  - the agent is PUBLIC. Migration 0047 withholds a private agent's
   *    performance; resolving a public thesis against one would publish the
   *    withheld number through the side door.
   *  - every benchmark symbol is one the market actually records. A ticker
   *    nobody has prices for cannot be beaten or missed, and the failure would
   *    surface months later as a verdict of 0.0% against 0.0%.
   */
  async create(creatorId: string, agentOwnerCreatorId: string, dto: CreateThesisDto) {
    if (creatorId !== agentOwnerCreatorId) {
      // assertOwnsAgent already refused a foreign agent; this catches the
      // stranger case of a wallet that owns the agent through a different
      // creator profile than the one it is publishing as.
      throw new ConflictException({
        error: {
          code: 'thesis_creator_mismatch',
          message:
            'the agent belongs to a different creator profile than the one publishing this thesis',
        },
      });
    }

    const agent = await this.db.query(
      `SELECT status, visibility, name FROM agents WHERE id = $1`,
      [dto.linked_agent_id],
    );
    if (agent.length === 0) throw new NotFoundException(`Agent ${dto.linked_agent_id} not found`);
    const { status, visibility } = agent[0];

    if (status !== 'active') {
      throw new BadRequestException({
        error: {
          code: 'thesis_agent_not_active',
          message:
            `the agent is ${status}. A thesis is measured over an agent that is deciding; ` +
            'binding one to an agent that is not would produce a verdict about nothing',
        },
      });
    }
    if (visibility !== 'public') {
      throw new BadRequestException({
        error: {
          code: 'thesis_agent_not_public',
          message:
            'a public thesis can only be bound to a public agent. Resolving one against a ' +
            'private agent would publish the performance that its visibility withholds',
        },
      });
    }

    const resolvesAt = new Date(dto.resolves_at);
    const now = Date.now();
    if (Number.isNaN(resolvesAt.getTime())) {
      throw new BadRequestException({
        error: { code: 'thesis_bad_deadline', message: 'resolves_at is not a valid timestamp' },
      });
    }
    const span = resolvesAt.getTime() - now;
    if (span < MIN_WINDOW_MS || span > MAX_WINDOW_MS) {
      throw new BadRequestException({
        error: {
          code: 'thesis_window_out_of_range',
          message:
            'resolves_at must be between 24 hours and 365 days from now. A shorter window is a ' +
            'coin flip dressed as a forecast; a longer one outlives the agent it names',
        },
      });
    }

    const benchmark = await this.validateBenchmark(dto.benchmark_ref);

    const rows = await this.db.query(
      `INSERT INTO public_theses
         (creator_id, linked_agent_id, claim_text, benchmark_ref, criteria, resolves_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING id, created_at, resolves_at, status`,
      [
        creatorId,
        dto.linked_agent_id,
        dto.claim_text.trim(),
        JSON.stringify(benchmark),
        JSON.stringify({ comparison: dto.criteria.comparison, margin_pct: dto.criteria.margin_pct }),
        resolvesAt,
      ],
    );

    return {
      id: rows[0].id,
      status: rows[0].status,
      created_at: rows[0].created_at,
      resolves_at: rows[0].resolves_at,
      // Said back at creation, because it is the one moment a creator can still
      // choose not to publish.
      note:
        'Published. The claim, its benchmark, its criteria and its deadline are now fixed, and ' +
        'the result will be attached automatically when the deadline passes. It cannot be ' +
        'deleted or edited, and the agent it names is not told it was bound.',
    };
  }

  /** Normalises the benchmark and refuses tickers the market never priced. */
  private async validateBenchmark(ref: { kind: string; symbols?: string[] }) {
    if (ref.kind === 'arcana_index') {
      if (ref.symbols && ref.symbols.length > 0) {
        throw new BadRequestException({
          error: {
            code: 'thesis_benchmark_invalid',
            message: 'the ARCANA index is the whole market; it takes no symbol list',
          },
        });
      }
      return { kind: 'arcana_index' as const };
    }

    const symbols = (ref.symbols ?? []).map((s) => s.toUpperCase());
    if (ref.kind === 'symbol' && symbols.length !== 1) {
      throw new BadRequestException({
        error: { code: 'thesis_benchmark_invalid', message: 'kind=symbol takes exactly one symbol' },
      });
    }
    if (ref.kind === 'basket' && symbols.length < 2) {
      throw new BadRequestException({
        error: {
          code: 'thesis_benchmark_invalid',
          message: 'kind=basket takes two or more symbols; one symbol is kind=symbol',
        },
      });
    }

    const known = await this.knownSymbols();
    const unknown = symbols.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      throw new BadRequestException({
        error: {
          code: 'thesis_benchmark_unknown_symbol',
          message:
            `no market snapshot carries ${unknown.join(', ')}. A benchmark nobody records a ` +
            `price for cannot be beaten or missed. Known symbols: ${[...known].sort().join(', ')}`,
        },
      });
    }
    return { kind: ref.kind as 'symbol' | 'basket', symbols };
  }

  /** Symbols priced in the most recent tick — the ones a benchmark can use. */
  private async knownSymbols(): Promise<Set<string>> {
    const index = await this.marketIndex.load();
    const latest = [...index.values()].sort(
      (a, b) => b.tickTime.getTime() - a.tickTime.getTime())[0];
    if (!latest) return new Set();
    const withPrices = await this.marketIndex.load({ withPricesFor: [latest.ref] });
    return new Set(Object.keys(withPrices.get(latest.ref)?.prices ?? {}));
  }

  // ------------------------------------------------------------------- read

  /** 🌐 One thesis, with everything a reader needs to disagree with it. */
  async findOne(id: string) {
    const rows = await this.db.query(
      `SELECT t.*, c.handle AS creator_handle, a.name AS agent_name, a.status AS agent_status,
              ar.id AS article_id, ar.title AS article_title
         FROM public_theses t
         JOIN creators c ON c.id = t.creator_id
         JOIN agents a ON a.id = t.linked_agent_id
         LEFT JOIN articles ar ON ar.thesis_id = t.id
        WHERE t.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`Thesis ${id} not found`);
    return this.present(rows[0]);
  }

  /**
   * 🌐 Every thesis a creator has published — including the ones going badly.
   *
   * PAGED, but `record` is counted from the creator's own counters rather than
   * from the page: a proven rate computed over whatever rows this page happens
   * to hold would shrink as you page forward, which is the one number on here
   * that must not move.
   */
  async listForCreator(creatorId: string, page: number, pageSize: number, offset: number) {
    const rows = await this.db.query(
      `SELECT t.*, c.handle AS creator_handle, a.name AS agent_name, a.status AS agent_status,
              ar.id AS article_id, ar.title AS article_title
         FROM public_theses t
         JOIN creators c ON c.id = t.creator_id
         JOIN agents a ON a.id = t.linked_agent_id
         LEFT JOIN articles ar ON ar.thesis_id = t.id
        WHERE t.creator_id = $1
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [creatorId, pageSize, offset],
    );
    const counters = await this.db.query(
      `SELECT theses_published, theses_proven FROM creators WHERE id = $1`, [creatorId]);
    if (counters.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);

    const published: number = counters[0].theses_published;
    const proven: number = counters[0].theses_proven;
    return {
      creator_id: creatorId,
      page,
      page_size: pageSize,
      total: published,
      has_more: offset + rows.length < published,
      record: {
        published,
        proven,
        // DENOMINATOR IS EVERYTHING EVER PUBLISHED, pending included. Ten
        // theses with three proven must not read like three with three, and a
        // creator cannot withdraw the ones that stopped looking likely.
        proven_rate: published > 0 ? proven / published : null,
        basis:
          'proven out of every thesis ever published, including those still running. Nothing ' +
          'can be withdrawn once published.',
      },
      items: rows.map((r: Record<string, unknown>) => this.present(r)),
    };
  }

  /** 🌐 Recently published, newest first. */
  async listRecent(page: number, pageSize: number, offset: number) {
    const [rows, totalRow] = await Promise.all([
      this.db.query(
        `SELECT t.*, c.handle AS creator_handle, a.name AS agent_name, a.status AS agent_status,
              ar.id AS article_id, ar.title AS article_title
           FROM public_theses t
           JOIN creators c ON c.id = t.creator_id
           JOIN agents a ON a.id = t.linked_agent_id
         LEFT JOIN articles ar ON ar.thesis_id = t.id
          ORDER BY t.created_at DESC
          LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ),
      this.db.query(`SELECT count(*)::int AS n FROM public_theses`),
    ]);
    const total: number = totalRow[0]?.n ?? 0;
    return {
      page,
      page_size: pageSize,
      total,
      has_more: offset + rows.length < total,
      items: rows.map((r: Record<string, unknown>) => this.present(r)),
    };
  }

  /**
   * One row, as the API shows it.
   *
   * `result_*` stay null while pending rather than becoming 0: a claim not yet
   * answered and a claim answered with no movement are different facts, and a
   * page cannot tell them apart from a zero.
   */
  private present(r: Record<string, any>) {
    return {
      id: r.id,
      creator: { id: r.creator_id, handle: r.creator_handle },
      agent: { id: r.linked_agent_id, name: r.agent_name, status_now: r.agent_status },
      // The article that carries this claim, if one does. A stub rather than
      // the whole article, because the article read inlines the thesis and two
      // full objects pointing at each other is a loop.
      article: r.article_id ? { id: r.article_id, title: r.article_title } : null,
      claim: r.claim_text,
      benchmark: r.benchmark_ref,
      criteria: r.criteria,
      created_at: r.created_at,
      resolves_at: r.resolves_at,
      status: r.status,
      result:
        r.status === 'pending'
          ? null
          : {
              agent_return: Number(r.result_performance),
              benchmark_return: Number(r.result_benchmark),
              margin: Number(r.result_performance) - Number(r.result_benchmark),
              resolved_at: r.resolved_at,
              agent_status_at_resolution: r.agent_status_at_resolution,
              // WHETHER THE FIGURES ABOVE ARE EXACT. False when an external
              // transfer could not be priced and so was never removed from the
              // agent's return. Surfaced as its own field rather than buried in
              // `measurement`, because a consumer that reads `agent_return` and
              // not the blob would otherwise print a hole as a number.
              measurement_complete: r.measurement?.complete !== false,
              incomplete_because: r.measurement?.incomplete_because ?? null,
              // The worked numbers, so the verdict can be recomputed rather
              // than taken. This is the whole difference between a record and
              // a claim about a record.
              measurement: r.measurement,
            },
      basis:
        'The agent return is time-weighted with recorded external flows removed, so a deposit or ' +
        'withdrawal cannot decide a claim about the market. It will therefore differ from the ' +
        'ARCANA Score, which reads the raw NAV series by design.',
    };
  }

  // --------------------------------------------------------------- articles

  async createArticle(creatorId: string, dto: CreateArticleDto) {
    if (dto.thesis_id) {
      const t = await this.db.query(
        `SELECT creator_id FROM public_theses WHERE id = $1`, [dto.thesis_id]);
      if (t.length === 0) throw new NotFoundException(`Thesis ${dto.thesis_id} not found`);
      if (t[0].creator_id !== creatorId) {
        throw new ConflictException({
          error: {
            code: 'article_thesis_not_yours',
            message: 'an article can only carry a thesis its own author published',
          },
        });
      }
      const taken = await this.db.query(
        `SELECT id FROM articles WHERE thesis_id = $1`, [dto.thesis_id]);
      if (taken.length > 0) {
        throw new ConflictException({
          error: {
            code: 'article_thesis_taken',
            message: `thesis ${dto.thesis_id} is already carried by article ${taken[0].id}`,
          },
        });
      }
    }

    // The agent, if one is named. OWNERSHIP IS CHECKED BY THE CONTROLLER
    // (assertOwnsAgent) before this runs; what is checked here is that the row
    // exists at all, so a typo'd id fails as a 404 rather than as a foreign key
    // violation the caller cannot read.
    if (dto.agent_id) await this.assertAgentExists(dto.agent_id);

    const rows = await this.db.query(
      `INSERT INTO articles (creator_id, title, body, thesis_id, agent_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [creatorId, dto.title.trim(), dto.body, dto.thesis_id ?? null, dto.agent_id ?? null],
    );
    return {
      id: rows[0].id,
      created_at: rows[0].created_at,
      thesis_id: dto.thesis_id ?? null,
      agent_id: dto.agent_id ?? null,
    };
  }

  private async assertAgentExists(agentId: string) {
    const rows = await this.db.query(`SELECT id FROM agents WHERE id = $1`, [agentId]);
    if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
  }

  async updateArticle(creatorId: string, id: string, dto: UpdateArticleDto) {
    const rows = await this.db.query(
      `SELECT creator_id, agent_id, hidden_at FROM articles WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`Article ${id} not found`);
    if (rows[0].creator_id !== creatorId) {
      throw new ConflictException({
        error: { code: 'article_not_yours', message: 'only the author can edit an article' },
      });
    }
    if (rows[0].hidden_at) {
      throw new ConflictException({
        error: {
          code: 'content_hidden',
          message:
            'this article has been hidden by moderation and cannot be edited; editing it would ' +
            'change what was acted on while the record still says it was acted on',
        },
      });
    }

    // THE AGENT BINDING IS A FIRST SETTING, NEVER A MOVE. The trigger in 0056
    // refuses the move as well, and refusing here too is what turns it into a
    // sentence: a bare trigger error names a constraint, not a reason.
    if (dto.agent_id !== undefined && rows[0].agent_id && dto.agent_id !== rows[0].agent_id) {
      throw new ConflictException({
        error: {
          code: 'article_agent_fixed',
          message:
            `this article already names agent ${rows[0].agent_id}. Its Linked Agent card ` +
            'publishes that agent\'s score and returns, so the binding cannot be moved to ' +
            'another — an article re-pointed at an agent that later did well is a track record ' +
            'nobody wrote about.',
        },
      });
    }
    if (dto.agent_id) await this.assertAgentExists(dto.agent_id);

    await this.db.query(
      `UPDATE articles
          SET title = coalesce($2, title), body = coalesce($3, body),
              agent_id = coalesce(agent_id, $4)
        WHERE id = $1`,
      [id, dto.title?.trim() ?? null, dto.body ?? null, dto.agent_id ?? null],
    );
    return this.findArticle(id);
  }

  /**
   * 🌐 One article, with its thesis inlined when it carries one.
   *
   * THE AGENT IS AN IDENTITY, NOT A SNAPSHOT. `agent` carries the id, the name,
   * and the two facts that decide how honest a card can be — its lifecycle
   * status and whether it is public. It carries NO score, NO return and NO
   * drawdown: those are read live by the card from the agent's own endpoints,
   * which is the whole reason the card and the agent page cannot disagree.
   *
   * A HIDDEN ARTICLE ANSWERS 200 WITH NO BODY, like a hidden thread. "Removed,
   * and here is why" and "never existed" are different facts.
   */
  async findArticle(id: string) {
    const rows = await this.db.query(
      `SELECT a.*, c.handle AS creator_handle,
              ag.name AS agent_name, ag.status AS agent_status, ag.visibility AS agent_visibility
         FROM articles a
         JOIN creators c ON c.id = a.creator_id
         LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`Article ${id} not found`);
    const a = rows[0];
    const hidden = a.hidden_at
      ? { at: a.hidden_at, reason: a.hidden_reason ?? 'no reason recorded' }
      : null;

    return {
      id: a.id,
      creator: { id: a.creator_id, handle: a.creator_handle },
      title: hidden ? null : a.title,
      body: hidden ? null : a.body,
      created_at: a.created_at,
      updated_at: a.updated_at,
      thesis: a.thesis_id && !hidden ? await this.findOne(a.thesis_id) : null,
      agent: a.agent_id
        ? {
            id: a.agent_id,
            name: a.agent_name,
            status_now: a.agent_status,
            visibility: a.agent_visibility,
          }
        : null,
      like_count: Number(a.like_count ?? 0),
      save_count: Number(a.save_count ?? 0),
      comment_count: Number(a.comment_count ?? 0),
      hidden,
    };
  }

  /** 🌐 A creator's articles, newest first. Hidden ones are not listed. */
  async listArticles(creatorId: string) {
    const rows = await this.db.query(
      `SELECT a.id, a.title, a.thesis_id, a.agent_id, a.created_at, a.updated_at,
              a.like_count, a.save_count, a.comment_count,
              ag.name AS agent_name
         FROM articles a
         LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.creator_id = $1 AND a.hidden_at IS NULL
        ORDER BY a.created_at DESC`,
      [creatorId],
    );
    return { creator_id: creatorId, items: rows.map((r: Record<string, any>) => this.articleCard(r)) };
  }

  /** 🌐 Recent articles across the platform, newest first. */
  async listRecentArticles(page: number, pageSize: number, offset: number) {
    const [rows, totalRow] = await Promise.all([
      this.db.query(
        `SELECT a.id, a.title, a.thesis_id, a.agent_id, a.created_at, a.updated_at,
                a.like_count, a.save_count, a.comment_count,
                c.id AS creator_id, c.handle AS creator_handle, ag.name AS agent_name
           FROM articles a
           JOIN creators c ON c.id = a.creator_id
           LEFT JOIN agents ag ON ag.id = a.agent_id
          WHERE a.hidden_at IS NULL
          ORDER BY a.created_at DESC
          LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ),
      this.db.query(`SELECT count(*)::int AS n FROM articles WHERE hidden_at IS NULL`),
    ]);
    const total: number = totalRow[0]?.n ?? 0;
    return {
      page,
      page_size: pageSize,
      total,
      has_more: offset + rows.length < total,
      items: rows.map((r: Record<string, any>) => ({
        ...this.articleCard(r),
        creator: { id: r.creator_id, handle: r.creator_handle },
      })),
    };
  }

  /**
   * 🌐 The articles written about one agent.
   *
   * WHAT THIS IS NOT: an input to anything. It is a read, by the agent's own
   * page, of writing that names it. The agent is never told, exactly as it is
   * never told about a thesis — see 0052 and infra/verify/forum-verify.mjs.
   */
  async listArticlesForAgent(agentId: string, page: number, pageSize: number, offset: number) {
    await this.assertAgentExists(agentId);
    const [rows, totalRow] = await Promise.all([
      this.db.query(
        `SELECT a.id, a.title, a.thesis_id, a.agent_id, a.created_at, a.updated_at,
                a.like_count, a.save_count, a.comment_count,
                c.id AS creator_id, c.handle AS creator_handle
           FROM articles a
           JOIN creators c ON c.id = a.creator_id
          WHERE a.agent_id = $1 AND a.hidden_at IS NULL
          ORDER BY a.created_at DESC
          LIMIT $2 OFFSET $3`,
        [agentId, pageSize, offset],
      ),
      this.db.query(
        `SELECT count(*)::int AS n FROM articles WHERE agent_id = $1 AND hidden_at IS NULL`,
        [agentId],
      ),
    ]);
    const total: number = totalRow[0]?.n ?? 0;
    return {
      agent_id: agentId,
      page,
      page_size: pageSize,
      total,
      has_more: offset + rows.length < total,
      items: rows.map((r: Record<string, any>) => ({
        ...this.articleCard(r),
        creator: { id: r.creator_id, handle: r.creator_handle },
      })),
    };
  }

  /** One article as a list entry. No body, and no number this file worked out. */
  private articleCard(r: Record<string, any>) {
    return {
      id: r.id,
      title: r.title,
      thesis_id: r.thesis_id ?? null,
      agent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? null } : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      like_count: Number(r.like_count ?? 0),
      save_count: Number(r.save_count ?? 0),
      comment_count: Number(r.comment_count ?? 0),
    };
  }
}
