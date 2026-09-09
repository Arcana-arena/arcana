import {
  IsDateString,
  IsIn,
  IsJSON,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ACCESS_TIERS, AccessTier } from '../season.entity';

export class CreateSeasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  universe: string;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsJSON()
  ruleset: string;

  /**
   * Omitted means `standard`. Premium is always something a caller asked for:
   * an arena must never become gated as a side effect of a default.
   */
  @IsOptional()
  @IsIn(ACCESS_TIERS)
  accessTier?: AccessTier;
}
