import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard } from '@arcana/auth';
import { AuthService } from './auth.service';
import { OwnershipService } from './ownership.service';
import { RefreshDto, VerifySiweDto } from './dto/auth.dto';

/**
 * Sign-in surface.
 *
 * `nonce`, `verify` and `refresh` are necessarily unauthenticated — they are
 * how a caller becomes authenticated. `me` and `logout-all` require a session,
 * because they are about one.
 *
 * ARCANA never asks for, receives or stores a private key: the wallet signs
 * locally and only the resulting signature crosses the wire.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly ownership: OwnershipService,
  ) {}

  /** Step 1: obtain a single-use nonce to embed in the SIWE message. */
  @Get('nonce')
  nonce() {
    return this.auth.issueNonce();
  }

  /** Step 2: present the signed message and receive a session. */
  @Post('verify')
  @HttpCode(200)
  verify(@Body() dto: VerifySiweDto) {
    return this.auth.verifySignIn(dto.message, dto.signature);
  }

  /** Exchange a refresh token for a new pair. The old one dies here. */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  /** End one sign-in. Idempotent, and silent about tokens it does not know. */
  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refresh_token);
  }

  /** End every sign-in for the calling wallet. */
  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  logoutAll(@CurrentWallet() wallet: string) {
    return this.auth.revokeAllForWallet(wallet);
  }

  /**
   * Who the caller is, and whether that wallet has a creator profile yet.
   * `creator_id: null` is a normal state — signing in does not create one.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentWallet() wallet: string) {
    return {
      wallet_address: wallet,
      creator_id: await this.ownership.creatorIdForWallet(wallet),
    };
  }
}
