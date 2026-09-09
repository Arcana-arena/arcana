import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  assertSameWallet,
  CurrentWallet,
  InternalKeyGuard,
  JwtAuthGuard,
} from '@arcana/auth';
import { EntitlementService, GATED_ACTIONS } from './entitlement.service';

@Controller()
export class EntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  /**
   * ⚙️ GET /v1/arca/entitlements/check?user_id=&action= (§8).
   *
   * Machine tier: agent-service's EntitlementClient calls this while deciding
   * an action, having already established who the caller is. It is not a user
   * surface — a user learns what a gate requires from the season/arena listing,
   * which reports gate status without deciding anything.
   */
  @Get('v1/arca/entitlements/check')
  @UseGuards(InternalKeyGuard)
  async check(@Query('action') action?: string, @Query('user_id') userId?: string) {
    if (!action || !this.entitlements.isGatedAction(action)) {
      throw new BadRequestException(
        `action must be one of: ${GATED_ACTIONS.join(', ')}`,
      );
    }
    return this.entitlements.check(action, userId ?? null);
  }

  /**
   * 🔒 GET /v1/arca/accounts/:user_id (§8) — balance and every entitlement.
   *
   * Your own account only. The path segment is a wallet address, and answering
   * for any address handed in would have made every holder's balance and tier
   * readable by anyone who knew their address.
   */
  @Get('v1/arca/accounts/:userId')
  @UseGuards(JwtAuthGuard)
  async account(@Param('userId') userId: string, @CurrentWallet() wallet: string) {
    assertSameWallet(wallet, userId, 'This $ARCA account');
    return this.entitlements.account(userId);
  }
}
