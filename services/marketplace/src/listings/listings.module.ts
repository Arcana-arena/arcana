import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceListing } from './listing.entity';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { BrowseService } from './browse.service';
import { ListingOwnershipService } from './listing-ownership.service';

@Module({
  imports: [TypeOrmModule.forFeature([MarketplaceListing])],
  controllers: [ListingsController],
  providers: [ListingsService, BrowseService, ListingOwnershipService],
})
export class ListingsModule {}
