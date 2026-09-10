import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
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

  /**
   * Step 1: obtain a single-use nonce to embed in the SIWE message.
   *
   * THE MOST EXPOSED ENDPOINT IN THE SYSTEM, and until now the least
   * defended. It is unauthenticated by necessity — it is how a caller becomes
   * authenticated, so there is nothing to check — and it **writes a row to the
   * database every time it is called**. A loop over it fills the nonce table
   * as fast as the network allows, from a machine that has never proved it is
   * anybody, and the first symptom is the disk filling.
   *
   * 20 per minute per IP. A real sign-in needs ONE. The allowance is this wide
   * only because a shared office or a mobile carrier NATs many people behind
   * one address, and locking those people out to stop an attacker who is
   * merely inconvenienced by it is a bad trade. It is still three orders of
   * magnitude below what a loop achieves.
   */
  @Get('nonce')
  @RateLimit({ limit: 20, windowSeconds: 60 })
  nonce() {
    return this.auth.issueNonce();
  }

  /**
   * Step 2: present the signed message and receive a session.
   *
   * Limited separately, and more tightly, because this one verifies a
   * signature — elliptic-curve recovery, which is CPU the caller does not pay
   * for. On a 2 GB single-core host, unbounded signature verification from an
   * unauthenticated caller is a way to stop the whole platform without ever
   * signing in.
   */
  @Post('verify')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  verify(@Body() dto: VerifySiweDto) {
    return this.auth.verifySignIn(dto.message, dto.signature);
  }

  /**
   * Exchange a refresh token for a new pair. The old one dies here.
   *
   * Rate limited as a brute-force ceiling, not for load. A refresh token is a
   * bearer secret, and this endpoint says whether a guess was right. 30/min is
   * far above what any client needs and far below what guessing needs.
   */
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
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
