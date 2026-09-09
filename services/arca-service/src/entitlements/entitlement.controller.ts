import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { EntitlementService, GATED_ACTIONS } from './entitlement.service';

@Controller()
export class EntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  /** GET /v1/arca/entitlements/check?user_id=&action= (§8). */
  @Get('v1/arca/entitlements/check')
  async check(@Query('action') action?: string, @Query('user_id') userId?: string) {
    if (!action || !this.entitlements.isGatedAction(action)) {
      throw new BadRequestException(
        `action must be one of: ${GATED_ACTIONS.join(', ')}`,
      );
    }
    return this.entitlements.check(action, userId ?? null);
  }

  /** GET /v1/arca/accounts/:user_id (§8) — balance and every entitlement. */
  @Get('v1/arca/accounts/:userId')
  async account(@Param('userId') userId: string) {
    return this.entitlements.account(userId);
  }
}
