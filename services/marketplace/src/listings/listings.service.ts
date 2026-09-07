import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceListing } from './listing.entity';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';

@Injectable()
export class ListingsService {
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
      const body = await res.text();
      throw new Error(`arca-service subscribe failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  /**
   * Check whether a user currently has access to a listing (asks arca-service
   * for an active subscription).
   */
  async hasAccess(listingId: string, userWallet: string): Promise<boolean> {
    const res = await fetch(`${this.arcaUrl}/v1/subscriptions/${userWallet}`);
    if (!res.ok) return false;
    const subs = (await res.json()) as Array<{
      listingId: string;
      status: string;
      expiresAt: string;
    }>;
    return subs.some(
      (s) =>
        s.listingId === listingId &&
        s.status === 'active' &&
        new Date(s.expiresAt) > new Date(),
    );
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
