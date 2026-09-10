import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from './subscription.entity';
import { UserPushToken } from './user-push-token.entity';
import { ListingRef } from './listing-ref.entity';
import { PaymentClaim } from './payment-claim.entity';
import { ArcaTokenService } from './arca-token.service';
import { SubscriptionsService } from './subscriptions.service';
import { PushService, ReminderService } from './reminder.service';
import { ClaimsService } from './claims.service';
import { ArcaController } from './arca.controller';

/**
 * Payments.
 *
 * The §10 deposit-address subsystem was retired on 2026-09-11: HdWalletService,
 * DepositAddressesService, PaymentListenerService and the three entities only
 * they used (DepositAddress, PaymentEvent, ServiceState). Their replacement —
 * ClaimsService, buyer pays the creator directly and submits the transaction
 * hash — was proven in phase 11 against real USDG transfers before any of it
 * was removed, which is the order this project requires.
 *
 * The TABLES survive with COMMENT ON TABLE marking them retired (migration
 * 0028). Dropping them would destroy history for no gain; they are empty, and
 * an empty table costs nothing to keep.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subscription,
      UserPushToken,
      ListingRef,
      PaymentClaim,
    ]),
  ],
  controllers: [ArcaController],
  providers: [
    ArcaTokenService,
    SubscriptionsService,
    PushService,
    ReminderService,
    ClaimsService,
  ],
  exports: [
    SubscriptionsService,
    ArcaTokenService,
    ClaimsService,
  ],
})
export class PaymentsModule {}
