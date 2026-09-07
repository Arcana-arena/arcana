import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateListingDto {
  @IsUUID('4')
  agentId: string;

  @IsOptional()
  @IsIn(['subscription', 'one_time', 'strategy_access'])
  accessType?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  priceUsd?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  arcaGateAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  revenueShareCreator?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateListingDto {
  @IsOptional()
  @IsIn(['subscription', 'one_time', 'strategy_access'])
  accessType?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  priceUsd?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  arcaGateAmount?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
