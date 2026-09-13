import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A WHOLE risk profile, not a patch of one.
 *
 * The endpoint replaces rather than merges, and this DTO says so by taking the
 * object rather than individual keys. A merge cannot express removal: an owner
 * who wants a take-profit taken off would have no way to say it and would be
 * left with a level they believe they deleted.
 *
 * No key whitelist here, deliberately, and for the reason risk-profile.ts gives
 * at length: `risk_profile` is the owner's own JSON, a whitelist would make
 * every new lever a breaking change, and nothing is refused. What happens
 * instead is that the response names every key the engine will not read.
 */
export class SetRiskDto {
  @IsObject()
  riskProfile!: Record<string, unknown>;
}

/** Why an agent was paused. Recorded for the owner, never acted on. */
export class PauseAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  because?: string;
}
