import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceListing } from './listing.entity';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [TypeOrmModule.forFeature([MarketplaceListing])],
  controllers: [ListingsController],
  providers: [ListingsService],
})
export class ListingsModule {}
