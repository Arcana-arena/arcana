import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateCreatorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/, { message: 'handle must be lowercase alphanumeric/underscore' })
  handle: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  walletAddress?: string;
}
