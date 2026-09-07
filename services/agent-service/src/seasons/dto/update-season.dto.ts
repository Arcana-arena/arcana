import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
