import { Module } from '@nestjs/common';
import { EntitlementClient } from './entitlement.client';

/** Shared client so every gate point asks arca-service the same way. */
@Module({
  providers: [EntitlementClient],
  exports: [EntitlementClient],
})
export class EntitlementsModule {}
