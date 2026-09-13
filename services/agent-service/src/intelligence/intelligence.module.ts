import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';

/**
 * Global, because every read model that touches intelligence — agents, series,
 * passport, DNA, autopsy, evolution, overview, positions, status — masks through
 * the same service. Importing it module by module would make "forgot to import
 * it" a way to leak a private mandate.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [IntelligenceController],
  providers: [IntelligenceService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
