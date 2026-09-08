import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateDepositDto, DepositAddressesService } from './deposit-addresses.service';
import { PaymentListenerService } from './payment-listener.service';
import { PayoutBatchService } from './payout-batch.service';
import { ReminderService } from './reminder.service';
import { SubscriptionsService } from './subscriptions.service';

@Controller()
export class ArcaController {
  constructor(
    private readonly deposits: DepositAddressesService,
    private readonly listener: PaymentListenerService,
    private readonly payouts: PayoutBatchService,
    private readonly reminder: ReminderService,
    private readonly subs: SubscriptionsService,
  ) {}

  /** Generate a unique HD deposit address for (user, listing). */
  @Post('v1/arca/deposit-address')
  async createDeposit(@Body() dto: CreateDepositDto) {
    return this.deposits.generate(dto.userWallet, dto.listingId);
  }

  /** Run one listener poll cycle (internal/manual trigger + tests). */
  @Post('internal/v1/payments/listener/poll')
  async poll() {
    const processed = await this.listener.pollOnce();
    return { processed };
  }

  /** Audit pending deposits for funds that arrived but were never credited. */
  @Post('internal/v1/payments/listener/audit')
  async audit() {
    return this.listener.auditPendingDeposits();
  }

  /** Run one payout batch cycle (internal/manual trigger + tests). */
  @Post('internal/v1/payments/payout/run')
  async runPayouts() {
    return this.payouts.run();
  }

  /** Run one reminder cycle (internal/manual trigger + tests). */
  @Post('internal/v1/payments/reminder/run')
  async runReminder() {
    return this.reminder.run();
  }

  /**
   * Entitlement check — the single place the access rule lives (§2.7).
   *
   * Callers must not re-derive it from the subscription list: the rule spans
   * status AND the grace window, and a second copy in another service will
   * drift from this one (it already did — the marketplace's own copy kept
   * denying access all through the grace period).
   */
  @Get('v1/arca/access')
  async access(
    @Query('userWallet') userWallet?: string,
    @Query('listingId') listingId?: string,
  ) {
    if (!userWallet || !listingId) {
      throw new BadRequestException('userWallet and listingId query params are required');
    }
    return { access: await this.subs.hasAccess(userWallet, listingId) };
  }

  /** All subscriptions of a user (manual-renew status surface). */
  @Get('v1/subscriptions/:userWallet')
  async userSubscriptions(@Param('userWallet') userWallet: string) {
    return this.subs.forUser(userWallet);
  }
}
