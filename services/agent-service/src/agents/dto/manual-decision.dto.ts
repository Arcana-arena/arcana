import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ManualTradeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  symbol?: string;

  @IsIn(['buy', 'sell', 'hold'])
  action!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;
}

/**
 * A human's trade for one open tick.
 *
 * `agent_id` is absent on purpose — it comes from the path, and ownership of it
 * is proven before this payload is looked at. Everything else keeps the shape
 * the decision engine already accepts; this change moves the door, it does not
 * redesign manual trading.
 */
export class ManualDecisionDto {
  @IsUUID('all')
  season_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  market_snapshot_ref!: string;

  @ValidateNested()
  @Type(() => ManualTradeDto)
  trade!: ManualTradeDto;
}
