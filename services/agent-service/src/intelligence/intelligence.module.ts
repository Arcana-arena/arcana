import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReputationController } from '../reputation/reputation.controller';
import { ReputationService } from '../reputation/reputation.service';
import { AnchorsController } from './anchors.controller';
import { AnchorsService } from './anchors.service';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';

/**
 * Global, because every read model that touches intelligence — agents, series,
 * passport, DNA, autopsy, evolution, overview, positions, status — masks through
 * the same service. Importing it module by module would make "forgot to import
 * it" a way to leak a private mandate.
 *
 * Anchors live here too: they are the other half of the same proof. So does
 * verifiable reputation, which is proven through the same anchors. All of them
 * are REGISTERED below, not merely imported above — an unregistered provider is
 * a boot failure no type check sees (the 2026-09-14 outage).
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [IntelligenceController, AnchorsController, ReputationController],
  providers: [IntelligenceService, AnchorsService, ReputationService],
  exports: [IntelligenceService, AnchorsService, ReputationService],
})
export class IntelligenceModule {}
