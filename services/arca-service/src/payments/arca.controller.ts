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
import { CreateDepositDto, DepositAddressesService } from './deposit-addresses.service';
import { PaymentListenerService } from './payment-listener.service';
import { ReminderService } from './reminder.service';
import { SubscriptionsService } from './subscriptions.service';
import { ClaimsService } from './claims.service';

@Controller()
export class ArcaController {
  constructor(
    private readonly deposits: DepositAddressesService,
    private readonly listener: PaymentListenerService,
    private readonly reminder: ReminderService,
    private readonly subs: SubscriptionsService,
    private readonly claims: ClaimsService,
  ) {}

  /**
   * 🔑 Generate a unique HD deposit address for (caller, listing).
   *
   * The wallet is the caller's own, from the session — never a body field. It
   * used to be one, which meant anyone could mint a deposit address in anyone
   * else's name and watch the address that payment would be credited to.
   *
   * Non-custodial throughout: this derives a RECEIVING address. No user private
   * key is asked for, transmitted or stored.
   */
  @Post('v1/arca/deposit-address')
  @UseGuards(JwtAuthGuard)
  async createDeposit(@Body() dto: CreateDepositDto, @CurrentWallet() wallet: string) {
    return this.deposits.generate(wallet, dto.listingId);
  }

  // --- ⚙️ machine tier: batch jobs and timers -------------------------------

  /** Run one listener poll cycle. */
  @Post('internal/v1/payments/listener/poll')
  @UseGuards(InternalKeyGuard)
  async poll() {
    const processed = await this.listener.pollOnce();
    return { processed };
  }

  /** Audit pending deposits for funds that arrived but were never credited. */
  @Post('internal/v1/payments/listener/audit')
  @UseGuards(InternalKeyGuard)
  async audit() {
    return this.listener.auditPendingDeposits();
  }

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
