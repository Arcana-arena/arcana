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
import { assertSameWallet, CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { ListingsService } from './listings.service';
import { BrowseService } from './browse.service';
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
    private readonly browseSvc: BrowseService,
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

  /**
   * 🌐 The marketplace grid: every listing with the facts a buyer decides on.
   *
   * Distinct from `agents` above, which returns seven columns and was the only
   * read a browsing page had. This one carries the score AS THE LEADERBOARD
   * PUBLISHES IT (withheld, not lowered, for an agent that has not competed
   * enough), the season return and drawdown, a min/max sparkline, the
   * subscriber count, and — the field that decides whether the Subscribe button
   * means anything — whether this listing can be bought at all, with the reason
   * when it cannot.
   *
   * Filtering and ordering both happen in this service. A browser that sorts
   * its own rows is a second ranking, and this codebase publishes one.
   */
  @Get('browse')
  browse(
    @Query('q') q?: string,
    @Query('strategy') strategy?: string,
    @Query('universe') universe?: string,
    @Query('min_score') minScore?: string,
    @Query('max_price') maxPrice?: string,
    @Query('sort') sort?: string,
    @Query('buyable_only') buyableOnly?: string,
    @Query('include_unavailable') includeUnavailable?: string,
  ) {
    const numOrUndef = (v?: string) => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return this.browseSvc.browse({
      q,
      strategy,
      universe,
      minScore: numOrUndef(minScore),
      maxPrice: numOrUndef(maxPrice),
      sort,
      buyableOnly: buyableOnly === 'true',
      includeUnavailable: includeUnavailable === 'true',
    });
  }

  /**
   * 🌐 One listing, with everything stated BEFORE a buyer pays.
   *
   * The track record, what the subscription actually does in the buyer's own
   * wallet, the symbols the agent has really traded (not the universe it is
   * permitted to), and the smallest protective level this pool will accept —
   * which is the number that decides whether the buyer's own stop can be armed
   * at all. Discovered after the first tick, that is discovered too late.
   */
  @Get('listings/:id/detail')
  detail(@Param('id', ParseUuidAllPipe) id: string) {
    return this.browseSvc.detail(id);
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
   * 🌐 What to send, and to whom, to buy this listing.
   *
   * PUBLIC, and that is deliberate. A buyer has to know the price and the
   * payee before they sign in, the same way they can already read the listing
   * — and there is nothing private in the answer: the creator's address is
   * public on chain and the price is public on the listing.
   *
   * THIS ENDPOINT CLOSES A PAYMENT-REDIRECTION HOLE. Until it existed the
   * buyer learned the address from outside the platform, and anyone who could
   * substitute one in that path took the money — after which ARCANA's
   * verification refused their claim correctly, and too late. A refusal that
   * arrives after the loss is not a defence.
   *
   * Both figures come from arca-service, from the rows the verification reads.
   * Nothing is computed here.
   */
  @Get('listings/:id/quote')
  quote(@Param('id', ParseUuidAllPipe) id: string) {
    return this.listings.quote(id);
  }

  /**
   * 🔒 Payments you already made to this creator that are not yet claimed.
   *
   * For the buyer who paid and then closed the tab. It GRANTS NOTHING: it
   * returns candidate transaction hashes, and claiming one still goes through
   * every check unchanged. The wallet searched is the session's, never a body
   * field, so nobody can ask what somebody else has paid.
   *
   * Rate limited because each call reads the chain.
   */
  @Get('listings/:id/unclaimed-payments')
  @RateLimit({ limit: 10, windowSeconds: 300, byWallet: true })
  @UseGuards(JwtAuthGuard)
  unclaimedPayments(
    @Param('id', ParseUuidAllPipe) id: string,
    @CurrentWallet() wallet: string,
  ) {
    return this.listings.unclaimedPayments(id, wallet);
  }

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
  // Every attempt costs three RPC round trips to a node ARCANA pays for, and a
  // rejected claim costs exactly as much as an accepted one. Keyed by wallet:
  // the claimant is already proven by the session, which is the same fact the
  // sender check inside relies on.
  @RateLimit({ limit: 20, windowSeconds: 300, byWallet: true })
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
