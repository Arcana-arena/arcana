import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositAddress } from './deposit-address.entity';
import { PaymentEvent } from './payment-event.entity';
import { CreatorPayout } from './creator-payout.entity';
import { Subscription } from './subscription.entity';
import { UserPushToken } from './user-push-token.entity';
import { ListingRef } from './listing-ref.entity';
import { HdWalletService } from './hd-wallet.service';
import { DepositAddressesService } from './deposit-addresses.service';
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
    ]),
  ],
  controllers: [ArcaController],
  providers: [HdWalletService, DepositAddressesService],
  exports: [HdWalletService, DepositAddressesService],
})
export class PaymentsModule {}
