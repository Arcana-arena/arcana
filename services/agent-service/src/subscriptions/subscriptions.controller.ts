import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { SubscriptionsService } from './subscriptions.service';

/**
 * A buyer's own subscription: its wallet, its limits, its book, its key.
 *
 * EVERY ROUTE IS THE BUYER'S OWN. The subscription id is taken from the path
 * and the wallet from the session — never from a body — so there is no request
 * shape in which one buyer asks about another's money.
 *
 * NONE OF THEM REQUIRES AN ACTIVE SUBSCRIPTION. An expired buyer still owns
 * whatever the agent left in their wallet, and the moment they most need to
 * read it and take the key is after it has ended.
 */
@Controller()
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  /**
   * 🔒 Derive this subscription's trading wallet.
   *
   * Idempotent: the signer derives deterministically from the subscription id,
   * so asking twice returns the same address and there is no second wallet to
   * end up with. Fund it yourself — USDG to trade, ETH for gas. The agent never
   * spends anybody else's.
   */
  @Post('v1/subscriptions/:id/wallet')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  bind(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    return this.subs.bindWallet(id, wallet);
  }

  /** 🔒 What you hold, what was done for you, and whether it is still trading. */
  @Get('v1/subscriptions/:id/book')
  @UseGuards(JwtAuthGuard)
  book(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    return this.subs.book(id, wallet);
  }

  /**
   * 🔒 Your limits, and your stop.
   *
   * The creator chooses the direction; you choose how much is at stake. These
   * are YOUR limits — the creator's risk profile sizes the creator's wallet and
   * nothing else.
   */
  @Patch('v1/subscriptions/:id')
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: { riskProfile?: string; tradingPaused?: boolean },
    @CurrentWallet() wallet: string,
  ) {
    return this.subs.update(id, wallet, dto);
  }

  /**
   * 🔒 Take possession of the subscription's private key.
   *
   * Rate limited hard, and not for load: this returns key material, so the cost
   * of a stolen session token is bounded by how often it can be called before
   * anyone notices. Same rule as the agent export it mirrors.
   */
  @Post('v1/subscriptions/:id/wallet/export')
  @HttpCode(200)
  @RateLimit({ limit: 3, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  exportKey(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    return this.subs.exportKey(id, wallet);
  }
}
