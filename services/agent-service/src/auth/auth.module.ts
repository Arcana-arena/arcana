import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OwnershipService } from './ownership.service';
import { SiweVerifier } from './siwe.verifier';

/**
 * agent-service owns sign-in because it owns `creators` — the table a wallet
 * proves control of. arca-service and marketplace only VERIFY the tokens minted
 * here, via the shared guards in @arcana/auth.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, SiweVerifier, OwnershipService],
  exports: [OwnershipService, AuthService],
})
export class AuthModule {}
