import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { EntitlementController } from './entitlement.controller';
import { EntitlementService } from './entitlement.service';

/**
 * Entitlement gating. Depends on PaymentsModule only for ArcaTokenService —
 * the same read-only chain client the payment listener uses, so there is one
 * definition of "what this wallet holds".
 */
@Module({
  imports: [PaymentsModule],
  controllers: [EntitlementController],
  providers: [EntitlementService],
})
export class EntitlementsModule {}
