import { Type } from 'class-transformer';
import {
  IsDateString,
  IsJSON,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateSeasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  universe: string;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsJSON()
  ruleset: string;
}
