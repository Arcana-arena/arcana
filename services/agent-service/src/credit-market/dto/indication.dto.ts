import { IsInt, IsNumber, IsOptional } from 'class-validator';

/**
 * What a capital provider would supply to one agent. The shape is checked
 * here; the bounds are checked in CreditMarketService, which refuses with a
 * code and a sentence instead of a validator's list.
 */
export class IndicationDto {
  @IsNumber()
  amount_usdg!: number;

  /** The yearly rate asked, in basis points. Left out: no rate named. */
  @IsOptional()
  @IsInt()
  rate_bps?: number;
}
