import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class BenchmarkRefDto {
  @IsIn(['symbol', 'basket', 'arcana_index'])
  kind: 'symbol' | 'basket' | 'arcana_index';

  /**
   * Required for `symbol` (exactly one) and `basket` (two or more); refused for
   * `arcana_index`, which is the whole market by definition. The count rule is
   * checked in the service, where the refusal can say which kind was asked for.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @Matches(/^[A-Z][A-Z0-9.]{0,11}$/, {
    each: true,
    message: 'each symbol is an uppercase ticker, e.g. SPY',
  })
  symbols?: string[];
}

export class ThesisCriteriaDto {
  @IsIn(['gt'])
  comparison: 'gt';

  /**
   * Percentage points the agent must beat the benchmark by. 0 = any margin.
   *
   * Capped at 100 because a margin nobody could ever clear is a thesis written
   * to fail quietly, which is the mirror image of one written to pass quietly.
   */
  @IsInt()
  @Min(0)
  @Max(100)
  margin_pct: number;
}

export class CreateThesisDto {
  @IsUUID('4')
  linked_agent_id: string;

  @IsString()
  @Length(16, 2000)
  claim_text: string;

  @ValidateNested()
  @Type(() => BenchmarkRefDto)
  benchmark_ref: BenchmarkRefDto;

  @ValidateNested()
  @Type(() => ThesisCriteriaDto)
  criteria: ThesisCriteriaDto;

  /** When the claim is judged. Bounded to 24h..365d by the database (0052). */
  @IsISO8601()
  resolves_at: string;
}
