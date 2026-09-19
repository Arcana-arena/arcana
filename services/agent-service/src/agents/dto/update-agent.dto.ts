import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MANDATE_MAX_CHARS } from '../mandate-templates';
import { MAX_CADENCE_SECONDS, MIN_CADENCE_SECONDS } from '../cadence';

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

  /**
   * How often this agent decides, in seconds. The owner's number.
   *
   * ALLOWED ON AN ACTIVE AGENT, unlike the mandate, and the difference is not an
   * oversight. The mandate is what the agent is trying to do — editing it in
   * place would make the track record a claim about an agent that no longer
   * exists. Cadence is how often it is asked, and the record already says: every
   * decision carries its own timestamp and its own snapshot, so a change of
   * pace is visible in the series rather than hidden by it. An owner who has to
   * create a new version to slow their agent down would instead leave it
   * running at a pace they no longer want.
   *
   * 60 is the floor the data model imposes (snapshot refs resolve to the
   * minute); 2592000 is a month, past which the agent is parked rather than
   * paced and `retire` is the honest word for it. Both are also CHECK
   * constraints (0054), so a second writer cannot get this wrong.
   */
  @IsOptional()
  @IsInt()
  @Min(MIN_CADENCE_SECONDS)
  @Max(MAX_CADENCE_SECONDS)
  cadenceSeconds?: number;
}
