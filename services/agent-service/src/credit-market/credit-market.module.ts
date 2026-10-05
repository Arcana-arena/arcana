import { Module } from '@nestjs/common';
import { CreditMarketController } from './credit-market.controller';
import { CreditMarketService } from './credit-market.service';

@Module({
  controllers: [CreditMarketController],
  providers: [CreditMarketService],
})
export class CreditMarketModule {}
