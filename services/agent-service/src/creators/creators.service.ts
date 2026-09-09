import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Creator } from './creator.entity';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

@Injectable()
export class CreatorsService {
  constructor(
    @InjectRepository(Creator)
    private readonly creators: Repository<Creator>,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  /**
   * Register a creator profile for a wallet that has just proven itself.
   *
   * `wallet` is a parameter, not a body field — see CreateCreatorDto. The row
   * is stamped `origin='siwe'` and `wallet_verified_at=now()`, which is what
   * separates it from the frozen pre-auth rows: every ownership check requires
   * a non-NULL `wallet_verified_at`.
   */
  async create(dto: CreateCreatorDto, wallet: string): Promise<Creator> {
    const address = wallet.toLowerCase();

    const existing = await this.creators.findOne({
      where: { walletAddress: address },
    });
    if (existing) {
      throw new ConflictException(
        `This wallet already has the creator profile '${existing.handle}'.`,
      );
    }

    const creator = this.creators.create({
      handle: dto.handle,
      walletAddress: address,
      walletVerifiedAt: new Date(),
      origin: 'siwe',
    });
    return this.creators.save(creator);
  }

  findAll(): Promise<Creator[]> {
    return this.creators.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Creator> {
    const creator = await this.creators.findOne({ where: { id } });
    if (!creator) {
      throw new NotFoundException(`Creator ${id} not found`);
    }
    return creator;
  }

  /** Rename only. Ownership and moderation are not editable here — see the DTO. */
  async update(id: string, dto: UpdateCreatorDto): Promise<Creator> {
    const creator = await this.findOne(id);
    if (dto.handle !== undefined) creator.handle = dto.handle;
    return this.creators.save(creator);
  }

  /**
   * The agents belonging to one creator, paginated.
   *
   * A creator dashboard previously had to pull the whole of `/v1/agents` and
   * filter client-side — fine at nine agents, not at five hundred, and it made
   * every dashboard load proportional to the size of the platform rather than
   * to the size of the creator.
   *
   * Paginated from the first commit rather than added later: the audit found
   * unbounded list endpoints across the API, and adding another would have been
   * repeating a known mistake on purpose.
   */
  async listAgents(
    id: string,
    opts: { status?: string; page?: number; page_size?: number },
  ) {
    await this.findOne(id); // 404 for an unknown creator rather than an empty page

    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const requested = opts.page_size ?? 50;
    const pageSize = Math.min(Math.max(requested, 1), 200);

    const params: unknown[] = [id];
    let where = 'a.creator_id = $1';
    if (opts.status) {
      params.push(opts.status);
      where += ` AND a.status = $${params.length}`;
    }

    const totalRow = await this.db.query(
      `SELECT count(*)::int AS n FROM agents a WHERE ${where}`,
      params,
    );
    const total: number = totalRow[0]?.n ?? 0;

    const rows = await this.db.query(
      `SELECT a.id, a.name, a.version, a.status, a.strategy_type, a.asset_universe,
              a.parent_agent_id, a.created_at,
              (SELECT count(*)::int FROM decisions d WHERE d.agent_id = a.id) AS decisions,
              (SELECT s.arcana_score FROM score_snapshots s
                WHERE s.agent_id = a.id ORDER BY s.ts DESC LIMIT 1) AS latest_arcana_score
         FROM agents a
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return {
      creator_id: id,
      page,
      page_size: pageSize,
      page_size_clamped: requested > 200 || undefined,
      total_agents: total,
      total_pages: Math.max(Math.ceil(total / pageSize), 1),
      agents: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        strategy_type: r.strategy_type,
        asset_universe: r.asset_universe,
        parent_agent_id: r.parent_agent_id,
        created_at: r.created_at,
        decisions: r.decisions,
        // Null is honest for an agent that has never been scored; it is not 0.
        latest_arcana_score: r.latest_arcana_score === null ? null : Number(r.latest_arcana_score),
      })),
    };
  }
}
