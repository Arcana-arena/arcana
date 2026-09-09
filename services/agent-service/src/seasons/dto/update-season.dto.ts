import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ACCESS_TIERS, AccessTier } from '../season.entity';

export class UpdateSeasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  /**
   * Retiering a running arena affects REGISTRATIONS FROM THAT MOMENT ON only.
   * That is the same entry-not-tick rule the COMPETE gate follows: agents
   * already admitted keep competing, because ejecting them mid-season would
   * make a season's results depend on a config change rather than on trading.
   */
  @IsOptional()
  @IsIn(ACCESS_TIERS)
  accessTier?: AccessTier;
}
