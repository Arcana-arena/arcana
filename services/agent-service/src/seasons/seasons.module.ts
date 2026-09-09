import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Season } from './season.entity';
import { SeasonsController } from './seasons.controller';
import { SeasonsService } from './seasons.service';
import { EntitlementsModule } from '../entitlements/entitlements.module';

@Module({
  imports: [TypeOrmModule.forFeature([Season]), EntitlementsModule],
  controllers: [SeasonsController],
  providers: [SeasonsService],
  // Exported so the competition gate can read a season's tier through the same
  // service, rather than growing a second opinion about what "premium" means.
  exports: [SeasonsService],
})
export class SeasonsModule {}
