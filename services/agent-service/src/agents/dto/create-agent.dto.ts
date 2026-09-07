import {
  IsIn,
  IsJSON,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAgentDto {
  @IsUUID()
  creatorId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;

  @IsOptional()
  @IsJSON()
  riskProfile?: string; // JSON string; parsed into jsonb on persist

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  assetUniverse: string;

  @IsOptional()
  @IsUUID()
  parentAgentId?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'retired'])
  status?: string;
}
