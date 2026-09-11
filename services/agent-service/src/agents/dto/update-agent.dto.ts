import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { MANDATE_MAX_CHARS } from '../mandate-templates';

/**
 * Descriptive edits only.
 *
 * `status` is deliberately not accepted. It used to be, and because update()
 * assigned it straight onto the row, `PATCH {"status":"active"}` activated an
 * agent without the $ARCA entitlement check and without retiring the parent
 * version — bypassing both invariants that activate() exists to hold.
 *
 * Lifecycle moves through the endpoints that own them:
 *   activate → POST /v1/agents/:id/activate
 *   retire   → POST /v1/agents/:id/retire
 *
 * With `forbidNonWhitelisted` on the global pipe, sending `status` here is now
 * a 400 that names the field, not a silently ignored key.
 */
export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;

  /**
   * Retune the mandate without creating a new version.
   *
   * Allowed on a DRAFT only. Once an agent is active its mandate is part of
   * the record its track record was produced under, and quietly editing it
   * would make the leaderboard a claim about an agent that no longer exists.
   * Changing an active agent's intent is what evolve() is for — it creates a
   * version, and the version boundary is visible.
   */
  /** Free-text mandate, drafts only. Mutually exclusive with mandateTemplate. */
  @IsOptional()
  @IsString()
  @MaxLength(MANDATE_MAX_CHARS)
  mandate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  mandateTemplate?: string;

  @IsOptional()
  @IsObject()
  mandateParams?: Record<string, unknown>;
}
