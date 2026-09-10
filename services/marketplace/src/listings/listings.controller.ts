import {
  Body,
  Controller,
  Get,
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

  // POST listings/:id/subscribe was removed on 2026-09-11. It returned a
  // deposit address for the buyer to pay, and that address no longer exists:
  // payment goes creator-to-buyer with no ARCANA account in the middle. The
  // door is now POST listings/:id/claim-payment, directly below.

  /**
   * 🔑 Claim a payment made directly to the creator.
   *
   * The buyer transfers $ARCA to the creator's wallet themselves — ARCANA
   * never receives it — and then submits the transaction hash here.
   *
   * The claiming wallet is the SESSION's, never a body field. A hash is public
   * the moment it is mined, so if the claimant were something a caller could
   * state, anyone watching the chain could claim somebody else's payment.
   */
  @Post('listings/:id/claim-payment')
  @UseGuards(JwtAuthGuard)
  claimPayment(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: { txHash?: string },
    @CurrentWallet() wallet: string,
  ) {
    return this.listings.claimPayment(id, wallet, dto?.txHash ?? '');
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
