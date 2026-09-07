import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  walletAddress?: string;

  @IsOptional()
  @IsIn(['active', 'suspended', 'banned'])
  status?: string;
}
