import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  assertSameWallet,
  CurrentWallet,
  InternalKeyGuard,
  JwtAuthGuard,
} from '@arcana/auth';
import { ReminderService } from './reminder.service';
import { SubscriptionsService } from './subscriptions.service';
import { ClaimsService } from './claims.service';
import { EarningsService } from './earnings.service';

@Controller()
export class ArcaController {
  constructor(
    private readonly reminder: ReminderService,
    private readonly subs: SubscriptionsService,
    private readonly claims: ClaimsService,
    private readonly earnings: EarningsService,
  ) {}

  // --- ⚙️ machine tier: batch jobs and timers -------------------------------

  /** Run one reminder cycle. */
  @Post('internal/v1/payments/reminder/run')
  @UseGuards(InternalKeyGuard)
  async runReminder() {
    return this.reminder.run();
  }

  /**
   * ⚙️ Subscription access check — the single place the *listing access* rule
   * lives. Distinct from the $ARCA balance gating in EntitlementService: this
   * asks "has this wallet paid for this listing", that asks "does this wallet
   * hold enough $ARCA to perform an action". Both are called entitlements in
   * §2.7; only the second reads a balance.
   *
   * Callers must not re-derive it from the subscription list: the rule spans
   * status AND the grace window, and a second copy in another service will
   * drift from this one (it already did — the marketplace's own copy kept
   * denying access all through the grace period).
   *
   * Machine tier rather than user-facing: marketplace calls this on a user's
   * behalf, having already checked that the wallet it passes is the caller's
   * own. The user-facing door is GET /v1/marketplace/listings/:id/access.
   */
  @Get('v1/arca/access')
  @UseGuards(InternalKeyGuard)
  async access(
    @Query('userWallet') userWallet?: string,
    @Query('listingId') listingId?: string,
  ) {
    if (!userWallet || !listingId) {
      throw new BadRequestException('userWallet and listingId query params are required');
    }
    return { access: await this.subs.hasAccess(userWallet, listingId) };
  }

  /**
   * ⚙️ What a buyer must send, and to whom, for one listing.
   *
   * Read-only, and it exists to close a payment-redirection hole: until this
   * endpoint existed, a buyer learned the creator's address from OUTSIDE the
   * platform, and anyone who could substitute an address in that path took the
   * money. ARCANA's verification would then refuse their claim correctly,
   * after the loss.
   *
   * The payee and the amount come from `ClaimsService.resolvePayable()` and
   * `requiredBaseUnits()` — the same calls `claim()` makes, not a parallel
   * query that agrees today.
   *
   * Machine tier because the marketplace fronts it, the same as the claim
   * route. There is no user data in the answer; the tier is about where the
   * canonical version lives, not about secrecy.
   */
  @Get('internal/v1/payments/quote')
  @UseGuards(InternalKeyGuard)
  async quote(@Query('listingId') listingId?: string) {
    if (!listingId) throw new BadRequestException('listingId is required');
    return this.claims.quote(listingId);
  }

  /**
   * ⚙️ Can this agent's creator receive a payment at all?
   *
   * Asked by the marketplace BEFORE a listing is published, so a listing with
   * no payee is never created rather than created and found unbuyable. The
   * answer comes from `creatorWalletFor()` — the same lookup the verification
   * uses — so "can this be paid for" has one definition and not one per
   * caller.
   */
  @Get('internal/v1/payments/payable')
  @UseGuards(InternalKeyGuard)
  async payable(@Query('agentId') agentId?: string) {
    if (!agentId) throw new BadRequestException('agentId is required');
    return this.claims.isPayable(agentId);
  }

  /**
   * ⚙️ Transfers this buyer has already made to this listing's creator.
   *
   * THE CASE: somebody pays, then closes the tab before submitting the hash.
   * The money is theirs, on chain, and the platform knows nothing about it —
   * so it looks lost, and the freshness window is running.
   *
   * GRANTS NOTHING. It reads the chain for transfers whose sender is the
   * caller's own proven wallet and whose recipient is this listing's creator,
   * and hands back candidate hashes. Claiming them still goes through
   * `claim()` unchanged: every check, including the sender check and the
   * UNIQUE on tx_hash, applies exactly as before.
   *
   * That is why it opens no new surface. It reveals transactions involving the
   * caller's OWN wallet — which they can already see — and the creator's
   * address, which the quote above now states anyway.
   */
  @Get('internal/v1/payments/unclaimed')
  @UseGuards(InternalKeyGuard)
  async unclaimed(
    @Query('listingId') listingId?: string,
    @Query('userWallet') userWallet?: string,
  ) {
    if (!listingId || !userWallet) {
      throw new BadRequestException('listingId and userWallet are required');
    }
    return this.claims.findUnclaimed(userWallet, listingId);
  }

  /**
   * 🔑 Claim a marketplace payment by transaction hash.
   *
   * MACHINE TIER, and that is the security boundary. marketplace calls this
   * on a user's behalf having already verified, from the session, that the
   * wallet it passes is the caller's own. The claimant is therefore an
   * identity somebody proved, not a field somebody sent — which is the whole
   * basis of the sender check inside.
   *
   * The user-facing door is POST /v1/marketplace/listings/:id/claim-payment.
   */
  @Post('internal/v1/payments/claims')
  @UseGuards(InternalKeyGuard)
  async claimPayment(@Body() dto: { userWallet?: string; listingId?: string; txHash?: string }) {
    if (!dto?.userWallet || !dto?.listingId || !dto?.txHash) {
      throw new BadRequestException('userWallet, listingId and txHash are required');
    }
    return this.claims.claim(dto.userWallet, dto.listingId, dto.txHash);
  }

  /**
   * ⚙️ What one address holds: the settlement token, and the gas.
   *
   * MACHINE TIER, because the map from an agent to its wallet is not public —
   * publishing it would let anybody watch a specific person's positions in real
   * time. agent-service fronts this for the owner, having already checked that
   * the agent is theirs.
   *
   * BOTH BALANCES, AND THEY FAIL SEPARATELY. The token read needs a configured
   * token; the native read needs only an RPC. Returning one as zero because the
   * other could not be read would be the exact false this platform keeps
   * removing, so each carries its own `available` and its own reason.
   */
  @Get('internal/v1/chain/balances')
  @UseGuards(InternalKeyGuard)
  async balances(@Query('address') address?: string) {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new BadRequestException('address is required and must be a 0x-prefixed 20-byte address');
    }
    return this.claims.balances(address);
  }

  /**
   * 🌐 The terms every subscription on this platform is sold under.
   *
   * PUBLIC, and it has to be. A buyer needs the term length, the grace window,
   * how long a payment stays claimable and how many confirmations are required
   * BEFORE they decide — and until now those four numbers existed only as
   * environment variables read inside this service. Documentation that quotes
   * them from memory is documentation that will one day be wrong; this is where
   * it reads them from.
   *
   * There is nothing private here: the payment token address and the chain id
   * are on chain, and the rest are the rules of the shop.
   */
  @Get('v1/arca/terms')
  terms() {
    return this.claims.terms();
  }

  /**
   * ⚙️ What a creator has been paid, and by whom.
   *
   * MACHINE TIER. agent-service fronts it for the owner, having checked that
   * the creator profile is theirs — the same arrangement the claim path uses,
   * and for the same reason: this service does not hold the session, so it must
   * not be the thing deciding who may see a creator's revenue.
   *
   * Every figure is a sum over `payment_claims`, the table the chain
   * verification writes. Not over `subscriptions`: access and money diverge in
   * both directions, and counting access as revenue reports money that never
   * moved.
   */
  @Get('internal/v1/creators/:id/earnings')
  @UseGuards(InternalKeyGuard)
  async creatorEarnings(@Param('id') id: string) {
    // The decimals are read from the token rather than assumed, and a failure
    // to read them leaves the human figures null rather than guessing a scale.
    let decimals: number | null = null;
    try {
      decimals = this.claims.paymentTokenEnabled ? await this.claims.paymentDecimals() : null;
    } catch {
      decimals = null;
    }
    return this.earnings.forCreator(id, decimals, this.claims.paymentTokenAddress);
  }

  /** 🔒 All subscriptions of a wallet — your own only. */
  @Get('v1/subscriptions/:userWallet')
  @UseGuards(JwtAuthGuard)
  async userSubscriptions(
    @Param('userWallet') userWallet: string,
    @CurrentWallet() wallet: string,
  ) {
    assertSameWallet(wallet, userWallet, 'This subscription list');
    return this.subs.forUser(userWallet);
  }
}
