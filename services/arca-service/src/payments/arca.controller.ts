import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateDepositDto, DepositAddressesService } from './deposit-addresses.service';
import { PaymentListenerService } from './payment-listener.service';
import { SubscriptionsService } from './subscriptions.service';

@Controller()
export class ArcaController {
  constructor(
    private readonly deposits: DepositAddressesService,
    private readonly listener: PaymentListenerService,
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

  /** All subscriptions of a user (manual-renew status surface). */
  @Get('v1/subscriptions/:userWallet')
  async userSubscriptions(@Param('userWallet') userWallet: string) {
    return this.subs.forUser(userWallet);
  }
}
