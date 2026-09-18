import {
  BadRequestException,
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
 import { AUTH_CONFIG, authUnavailable, type AuthConfig } from '@arcana/auth';
 import { Inject } from '@nestjs/common';

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);
  private readonly arcaUrl: string;

  constructor(
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
    config: ConfigService,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
  ) {
    this.arcaUrl = config.get<string>('ARCA_SERVICE_URL') ?? 'http://localhost:3003';
  }

  /**
   * Publish a listing.
   *
   * A LISTING WITHOUT A PAYEE CANNOT BE PUBLISHED. Two creators had no
   * wallet_address, so their listings refused every claim with
   * `creator_has_no_wallet` — the CORRECT refusal, and still a listing nobody
   * could ever buy. Refusing correctly is not the same as working.
   *
   * Checked here rather than cleaned up once, because cleaning up once fixes
   * the two rows that exist and none of the ones somebody creates tomorrow.
   *
   * The check asks arca-service, which owns the answer — the same service the
   * verification runs in. Asking a second place would be a second definition
   * of "can this be paid for", and this codebase has had one of those before.
   */
  async create(dto: CreateListingDto): Promise<MarketplaceListing> {
    await this.assertNotRetired(dto.agentId);
    await this.assertPayable(dto.agentId);
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
    // Reactivating is publishing. A listing deactivated because its creator
    // had no wallet must not come back without one, or the guard above is a
    // formality that one PATCH walks around.
    if (dto.active !== undefined) {
      if (dto.active && !listing.active) {
        await this.assertNotRetired(listing.agentId);
        await this.assertPayable(listing.agentId);
      }
      listing.active = dto.active;
    }
    return this.listings.save(listing);
  }

  /**
   * Refuse to publish a listing for an agent whose record has closed.
   *
   * ONLY `retired`, and that is the point. A draft agent has not started yet
   * and a paused one is between ticks; both become sellable again by an act
   * their creator can perform, and their listing simply waits, hidden, until
   * they do. Retirement is the one status that cannot be undone — resume()
   * refuses it by name — so a listing created against it could never become
   * buyable, and publishing it would only put a dead product where a live one
   * is supposed to be.
   *
   * Asked locally, unlike the payee check, because this service reads `agents`
   * directly in every discovery query it serves. There is no second definition
   * to drift from: the column is the fact.
   */
  private async assertNotRetired(agentId: string): Promise<void> {
    const rows: Array<{ status: string; name: string }> = await this.listings.manager.query(
      `SELECT status, name FROM agents WHERE id = $1`,
      [agentId],
    );
    if (rows.length === 0) return; // ownership has already been asserted upstream
    if (rows[0].status === 'retired') {
      throw new BadRequestException({
        code: 'agent_retired',
        message:
          `Agent ${agentId} (${rows[0].name}) has been retired, and a retired agent cannot come back — ` +
          'its record has closed. A listing for it could never be bought, so it is not published. List a ' +
          'running agent instead, or evolve this one and list the new version.',
      });
    }
  }

  /**
   * Refuse if this agent's creator cannot receive a payment.
   *
   * Delegated to arca-service's quote, which resolves the payee from the row
   * the VERIFICATION reads. A local query against creators would be a second
   * source for the same fact, and the two would agree right up until one of
   * them was edited.
   *
   * A quote that fails for any OTHER reason — the chain unreadable, the token
   * unconfigured — must not block publishing. That would make listing depend
   * on an RPC being up, which is a different and much worse property. Only
   * `creator_has_no_wallet` refuses.
   */
  private async assertPayable(agentId: string): Promise<void> {
    if (!this.authCfg.internalKey) {
      // No machine-tier key means this cannot be asked at all. REFUSING here
      // would be wrong in a specific way: it would make publishing depend on a
      // credential that has nothing to do with whether the creator has a
      // wallet, and a misconfigured host would look like a validation error.
      // The claim path still refuses correctly if the wallet is missing.
      this.logger.warn(
        'INTERNAL_API_KEY is not set, so the payee check was skipped for this listing',
      );
      return;
    }
    let res: Response;
    try {
      res = await fetch(
        `${this.arcaUrl}/internal/v1/payments/payable?agentId=${encodeURIComponent(agentId)}`,
        { headers: { 'X-Internal-Key': this.authCfg.internalKey } },
      );
    } catch {
      // arca-service unreachable. NOT a reason to refuse a listing: that would
      // make publishing depend on another service being up, which is a much
      // worse property than a listing that has to be fixed later.
      this.logger.warn(`payee check unavailable for agent ${agentId}; publishing anyway`);
      return;
    }
    if (!res.ok) {
      this.logger.warn(`payee check returned ${res.status} for agent ${agentId}; publishing anyway`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { payable?: boolean } | null;
    if (body?.payable === false) {
      throw new BadRequestException({
        code: 'creator_has_no_wallet',
        message:
          "This agent's creator has no wallet_address, so there is no address a buyer " +
          'could pay and no address the platform could verify a payment against. Link a ' +
          'wallet before publishing — a listing nobody can buy is worse than no listing.',
      });
    }
  }

  /**
   * What a buyer must send, and to whom, for one listing.
   *
   * Proxied straight through from arca-service, which resolves both from the
   * rows the VERIFICATION reads. Marketplace deliberately computes nothing
   * here — not the address, not the amount, not the decimals. A second
   * conversion in this service is exactly the divergence the endpoint exists
   * to prevent, and it would be invisible until a buyer underpaid by a factor
   * of a million and was told `insufficient_amount`.
   */
  async quote(listingId: string) {
    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so marketplace cannot reach the payment quote. ' +
        'No address or amount can be stated — do not send anything.',
      );
    }
    const listing = await this.findOne(listingId);
    if (!listing.active) {
      throw new NotFoundException(`Listing ${listingId} is inactive`);
    }
    const res = await fetch(
      `${this.arcaUrl}/internal/v1/payments/quote?listingId=${encodeURIComponent(listingId)}`,
      { headers: { 'X-Internal-Key': this.authCfg.internalKey } },
    );
    if (!res.ok) throw await this.upstreamError(res, 'quote');
    return res.json();
  }

  /**
   * Payments this buyer already made to this listing's creator, unclaimed.
   *
   * The buyer's wallet is the SESSION's, passed as a fact the way the claim
   * path passes it. A caller cannot ask what somebody else has paid.
   */
  async unclaimedPayments(listingId: string, userWallet: string) {
    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so marketplace cannot look for your payment.',
      );
    }
    const res = await fetch(
      `${this.arcaUrl}/internal/v1/payments/unclaimed` +
      `?listingId=${encodeURIComponent(listingId)}&userWallet=${encodeURIComponent(userWallet)}`,
      { headers: { 'X-Internal-Key': this.authCfg.internalKey } },
    );
    if (!res.ok) throw await this.upstreamError(res, 'unclaimed_payments');
    return res.json();
  }

  // subscribe() was removed on 2026-09-11 with the §10 deposit-address
  // subsystem it called. It asked arca-service to mint an address ARCANA
  // controlled and told the buyer to pay it; there is no such address any more,
  // because the buyer now pays the creator directly. claimPayment() below is
  // the whole of what replaced it, and it was proven against real USDG
  // transfers in phase 11 before this was taken out.

  /**
   * Claim a payment made directly to the creator, by transaction hash.
   *
   * The buyer's wallet comes from the caller's verified session and is passed
   * to arca-service as a fact, not forwarded as a token: this is the machine
   * tier, and marketplace has already established who is asking.
   */
  async claimPayment(listingId: string, userWallet: string, txHash: string) {
    if (!this.authCfg.internalKey) {
      // The same refusal hasAccess() makes: without the machine-tier key this
      // service cannot reach arca-service at all, and saying so is not the same
      // as saying the payment is invalid.
      throw authUnavailable(
        "INTERNAL_API_KEY is not set, so marketplace cannot reach payment verification",
      );
    }
    const listing = await this.findOne(listingId);
    if (!listing.active) {
      throw new NotFoundException(`Listing ${listingId} is inactive`);
    }
    const res = await fetch(`${this.arcaUrl}/internal/v1/payments/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': this.authCfg.internalKey },
      body: JSON.stringify({ userWallet, listingId, txHash }),
    });
    if (!res.ok) {
      throw await this.upstreamError(res, 'claim_payment');
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
   *
   * The wallet passed here has already been established as the caller's own by
   * the controller; arca's /v1/arca/access is a machine endpoint and trusts
   * that, which is why this call carries the internal key rather than a user
   * token.
   */
  async hasAccess(listingId: string, userWallet: string): Promise<boolean> {
    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so marketplace cannot reach the access check',
      );
    }
    const url =
      `${this.arcaUrl}/v1/arca/access` +
      `?userWallet=${encodeURIComponent(userWallet)}&listingId=${encodeURIComponent(listingId)}`;
    const res = await fetch(url, {
      headers: { 'X-Internal-Key': this.authCfg.internalKey },
    });
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
   *
   * TWO CONDITIONS THAT WERE MISSING, and the landing page reads this query.
   *
   * `l.active = true` was the whole of it, which asks whether the CREATOR left
   * the listing switched on and nothing about whether the agent behind it still
   * trades. A retired agent whose listing flag was never flipped was offered
   * here, on the front page, under a score it earned before it stopped. That is
   * the shape of the arcana_labs incident, and the repair it took was manual.
   *
   * `a.provenance = 'live'` is the rule every other public surface applies —
   * browse() has carried it from the start. Without it a fixture built by a
   * verification run is a product on the landing page for as long as that run
   * takes, which is a thing this platform must never sell.
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
      .andWhere("a.status = 'active'")
      .andWhere("a.provenance = 'live'")
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
