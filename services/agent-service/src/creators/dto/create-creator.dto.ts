import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * `walletAddress` is gone. The wallet comes from the caller's verified session,
 * so a creator profile is always bound to the wallet that proved control of it.
 *
 * Accepting it from the body was the hole: anyone could register a profile
 * claiming any address, and every per-wallet check downstream ($ARCA
 * entitlements, subscriptions, deposit addresses) would then trust it.
 */
export class CreateCreatorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/, { message: 'handle must be lowercase alphanumeric/underscore' })
  handle: string;
}
