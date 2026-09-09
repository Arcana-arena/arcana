import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { assertSameWallet, CurrentWallet, JwtAuthGuard } from '@arcana/auth';
import { ListingsService } from './listings.service';
import { ListingOwnershipService } from './listing-ownership.service';
import {
  CreateListingDto,
  UpdateListingDto,
} from './dto/listing.dto';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';

/**
 * Browsing the marketplace needs no account. Listing an agent, editing that
 * listing, subscribing, and reading your own access all do.
 */
@Controller('v1/marketplace')
export class ListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly ownership: ListingOwnershipService,
  ) {}

  /** 🔒 List one of your own agents. */
  @Post('listings')
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateListingDto, @CurrentWallet() wallet: string) {
    await this.ownership.assertOwnsAgent(wallet, dto.agentId);
    return this.listings.create(dto);
  }

  // --- 🌐 discovery is public ----------------------------------------------

  @Get('listings')
  findAll() {
    return this.listings.findAll();
  }

  @Get('agents')
  discover(@Query('universe') universe?: string, @Query('sort') sort?: string) {
    return this.listings.discover({ universe, sort });
  }

  @Get('listings/:id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.listings.findOne(id);
  }

  /** 🔒 Edit your own listing. */
  @Patch('listings/:id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateListingDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsListing(wallet, id);
    return this.listings.update(id, dto);
  }

  /**
   * 🔑 Subscribe: generate a deposit address via arca-service (no direct grant).
   *
   * The subscriber is the caller. The wallet used to arrive in the body, which
   * meant anyone could open a subscription in another person's name and see the
   * address their money would be expected at.
   *
   * The caller's own bearer token is forwarded to arca-service rather than
   * arca being told an address to trust: identity crosses the hop as proof, not
   * as data.
   */
  @Post('listings/:id/subscribe')
  @UseGuards(JwtAuthGuard)
  subscribe(
    @Param('id', ParseUuidAllPipe) id: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.listings.subscribe(id, authorization);
  }

  /**
   * 🔒 Does the caller have an active subscription to this listing?
   *
   * The wallet is the session's. A `userWallet` query naming somebody else is
   * refused rather than quietly answered about the caller instead — silently
   * substituting the subject would make the response mean something other than
   * what was asked.
   */
  @Get('listings/:id/access')
  @UseGuards(JwtAuthGuard)
  async hasAccess(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
    @Query('userWallet') userWallet?: string,
  ) {
    if (userWallet) {
      assertSameWallet(wallet, userWallet, 'That access record');
    }
    return { access: await this.listings.hasAccess(id, wallet) };
  }
}
