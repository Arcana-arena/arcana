import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositAddress } from './deposit-address.entity';
import { PaymentEvent } from './payment-event.entity';
import { CreatorPayout } from './creator-payout.entity';
import { Subscription } from './subscription.entity';
import { UserPushToken } from './user-push-token.entity';
import { ListingRef } from './listing-ref.entity';
import { ServiceState } from './service-state.entity';
import { HdWalletService } from './hd-wallet.service';
import { ArcaTokenService } from './arca-token.service';
import { DepositAddressesService } from './deposit-addresses.service';
import { SubscriptionsService } from './subscriptions.service';
import { PaymentListenerService } from './payment-listener.service';
import { PayoutBatchService } from './payout-batch.service';
import { PushService, ReminderService } from './reminder.service';
import { ArcaController } from './arca.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DepositAddress,
      PaymentEvent,
      CreatorPayout,
      Subscription,
      UserPushToken,
      ListingRef,
      ServiceState,
    ]),
  ],
  controllers: [ArcaController],
  providers: [
    HdWalletService,
    ArcaTokenService,
    DepositAddressesService,
    SubscriptionsService,
    PaymentListenerService,
    PayoutBatchService,
    PushService,
    ReminderService,
  ],
  exports: [
    HdWalletService,
    DepositAddressesService,
    SubscriptionsService,
    ArcaTokenService,
  ],
})
export class PaymentsModule {}
