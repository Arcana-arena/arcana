import { IsIn, IsJSON, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Partial overrides applied when evolving an agent to a new version. */
export class EvolveAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;

  @IsOptional()
  @IsJSON()
  riskProfile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  assetUniverse?: string;

  /**
   * Change the mandate as part of evolving.
   *
   * Omitted means INHERIT the parent's — the same rule every other field here
   * follows. Supplying only `mandateParams` re-renders the parent's template
   * with new values, which is the common case: the same idea, tuned.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mandateTemplate?: string;

  @IsOptional()
  @IsObject()
  mandateParams?: Record<string, unknown>;

  /**
   * Omitted means inherit the parent's visibility. A version of a PRIVATE agent
   * is always private — its template, parameters and risk rules come from the
   * parent, so a public child would publish them under another id. A version of
   * a public agent may start private: it is a new record from its first tick.
   */
  @IsOptional()
  @IsIn(['public', 'private'], { message: "visibility must be 'public' or 'private'." })
  visibility?: 'public' | 'private';
}
