import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceListing } from './listing.entity';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);
  private readonly arcaUrl: string;

  constructor(
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
    config: ConfigService,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://localhost:3003';
  }

  create(dto: CreateListingDto): Promise<MarketplaceListing> {
    const listing = this.listings.create({
      agentId: dto.agentId,
      accessType: dto.accessType ?? 'subscription',
      priceUsd: dto.priceUsd != null ? dto.priceUsd.toFixed(2) : null,
      arcaGateAmount:
        dto.arcaGateAmount != null ? dto.arcaGateAmount.toFixed(8) : null,
      revenueShareCreator: (dto.revenueShareCreator ?? 0.8).toFixed(2),
      active: dto.active ?? true,
    });
    return this.listings.save(listing);
  }

  findAll(): Promise<MarketplaceListing[]> {
    return this.listings.find({ order: { id: 'DESC' } });
  }

  async findOne(id: string): Promise<MarketplaceListing> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) {
      throw new NotFoundException(`Listing ${id} not found`);
    }
    return listing;
  }

  async update(id: string, dto: UpdateListingDto): Promise<MarketplaceListing> {
    const listing = await this.findOne(id);
    if (dto.accessType !== undefined) listing.accessType = dto.accessType;
    if (dto.priceUsd !== undefined)
      listing.priceUsd = dto.priceUsd.toFixed(2);
    if (dto.arcaGateAmount !== undefined)
      listing.arcaGateAmount = dto.arcaGateAmount.toFixed(8);
    if (dto.active !== undefined) listing.active = dto.active;
    return this.listings.save(listing);
  }

  /**
   * Subscribe to a listing: delegates to arca-service to generate a unique
   * HD deposit address. Access is granted only after the on-chain payment is
   * confirmed by the arca payment listener — NOT here.
   */
  async subscribe(listingId: string, userWallet: string) {
    const listing = await this.findOne(listingId);
    if (!listing.active) {
      throw new NotFoundException(`Listing ${listingId} is inactive`);
    }

    const res = await fetch(`${this.arcaUrl}/v1/arca/deposit-address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userWallet, listingId }),
    });
    if (!res.ok) {
      throw await this.upstreamError(res, 'subscribe');
    }
    return res.json();
  }

  /**
   * Turn a failed arca-service call into the §8 error shape with the upstream
   * status intact. Swallowing it into a generic 500 hid the real cause — a
   * deliberate "deposit generation disabled" refusal read to the caller as an
   * ARCANA crash.
   */
  private async upstreamError(res: Response, op: string): Promise<HttpException> {
    const traceId = randomUUID();
    let message = await res.text();
    try {
      const parsed = JSON.parse(message) as { message?: string | string[] };
      if (parsed?.message) {
        message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
      }
    } catch {
      // Upstream returned plain text — keep it as-is.
    }
    // Only client errors carry a meaningful upstream status; anything else is
    // an ARCANA-side fault and must not be blamed on the caller's request.
    const status = res.status >= 400 && res.status < 500 ? res.status : HttpStatus.BAD_GATEWAY;
    this.logger.error(`arca-service ${op} failed (${res.status}) [trace ${traceId}]: ${message}`);
    return new HttpException(
      { error: { code: `arca_${op}_failed`, message, trace_id: traceId } },
      status,
    );
  }

  /**
   * Check whether a user currently has access to a listing.
   *
   * The rule itself lives in arca-service (§2.7) and is asked for, not
   * reimplemented: this used to re-derive it from the subscription list with
   * `status === 'active' && expiresAt > now`, which silently denied access for
   * the whole grace window that arca-service was still honouring.
   */
  async hasAccess(listingId: string, userWallet: string): Promise<boolean> {
    const url =
      `${this.arcaUrl}/v1/arca/access` +
      `?userWallet=${encodeURIComponent(userWallet)}&listingId=${encodeURIComponent(listingId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw await this.upstreamError(res, 'access_check');
    }
    const body = (await res.json()) as { access?: boolean };
    return body.access === true;
  }

  /**
   * Agent discovery: active listings joined with the agent's latest ARCANA score
   * (score_snapshots latest per agent). Optional sort=score_desc (default) or
   * price_asc; filter by universe via agent row.
   */
  async discover(opts: {
    universe?: string;
    sort?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const qb = this.listings
      .createQueryBuilder('l')
      .select([
        'l.id AS id',
        'l.agent_id AS agent_id',
        'a.name AS agent_name',
        'a.asset_universe AS universe',
        'l.access_type AS access_type',
        'l.price_usd AS price_usd',
        'l.arca_gate_amount AS arca_gate_amount',
        's.arcana_score AS arcana_score',
      ])
      .innerJoin('agents', 'a', 'a.id = l.agent_id')
      .leftJoin(
        `(SELECT DISTINCT ON (agent_id) agent_id, arcana_score
          FROM score_snapshots ORDER BY agent_id, ts DESC)`,
        's',
        's.agent_id = l.agent_id',
      )
      .where('l.active = true')
      .orderBy(
        opts.sort === 'price_asc' ? 'l.price_usd' : 's.arcana_score',
        opts.sort === 'price_asc' ? 'ASC' : 'DESC',
      );

    if (opts.universe) {
      qb.andWhere('a.asset_universe = :universe', { universe: opts.universe });
    }

    return qb.getRawMany();
  }
}
