import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'retired'])
  status?: string;
}
