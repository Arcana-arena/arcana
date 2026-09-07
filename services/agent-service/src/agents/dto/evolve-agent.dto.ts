import { IsJSON, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
