import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Two fields were removed, both deliberately:
 *
 * `walletAddress` — a creator cannot re-point itself at a different wallet.
 * That single PATCH would have handed every agent the creator owns to another
 * address, silently, which is precisely the ownership hole this work closes.
 * A wallet proves itself at sign-in or not at all.
 *
 * `status` — active/suspended/banned is a moderation field, and it was
 * self-settable: a creator could un-ban themselves, or ban someone else back
 * when the endpoint was open. It is no longer reachable through the API by
 * anyone. Moderation needs an operator endpoint of its own; that is recorded in
 * docs/auth.md as deliberately deferred rather than quietly dropped.
 */
export class UpdateCreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/, { message: 'handle must be lowercase alphanumeric/underscore' })
  handle?: string;
}
