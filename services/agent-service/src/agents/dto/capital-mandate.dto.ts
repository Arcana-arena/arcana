import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsString, Max, Min } from 'class-validator';

/**
 * A capital mandate, whole. The shape is checked here; what the numbers are
 * ALLOWED to be is checked in CapitalMandateService, against the signer's own
 * allowlist, because that is where the platform's caps and tradable symbols
 * live and a copy kept here would drift from the one the signer enforces.
 */
export class CapitalMandateDto {
  @IsNumber()
  min_health_factor!: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  max_borrow_rate_bps!: number;

  @IsNumber()
  liquidity_trigger_usdg!: number;

  @IsNumber()
  max_borrow_usdg!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  never_sell!: string[];
}
