import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Point caps. Chosen so one page is a chart, not a database export. */
export const SERIES_PAGE_SIZE_DEFAULT = 500;
export const SERIES_PAGE_SIZE_MAX = 2000;
export const DECISIONS_PAGE_SIZE_DEFAULT = 100;
export const DECISIONS_PAGE_SIZE_MAX = 500;

/**
 * Upper bound on buckets an explicit `resolution` may produce.
 *
 * Without it, `resolution=1m` over a year is a request for half a million
 * buckets — the unbounded-list problem the audit found, reintroduced through a
 * query parameter. Exceeding it is a 400 that says how to fix it, not a slow
 * success.
 */
export const MAX_BUCKETS = 5000;

const DURATION = /^[1-9][0-9]{0,3}(m|h|d|w)$/;

export class SeriesQueryDto {
  /** Restrict to one season. Omitted, the series spans them — segmented, never merged. */
  @IsOptional()
  @IsUUID('all')
  season_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;

  /**
   * `raw` — every stored point (still page-capped).
   * `auto` — raw when it fits, otherwise bucketed to fit (default).
   * `15m` / `1h` / `1d` / `2w` — an explicit bucket width.
   */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(new RegExp(`^(raw|auto|${DURATION.source.slice(1, -1)})$`), {
    message: 'resolution must be raw, auto, or a duration such as 15m, 1h, 1d, 2w',
  })
  resolution?: string;
}

export class DecisionsQueryDto {
  @IsOptional()
  @IsUUID('all')
  season_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;

  @IsOptional()
  @IsIn(['buy', 'sell', 'hold', 'rebalance'])
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  symbol?: string;

  /** Set false to skip the market-data lookup when prices are not needed. */
  @IsOptional()
  @IsIn(['true', 'false'])
  include_prices?: string;
}

export class AgentListQueryDto {
  @IsOptional()
  @IsUUID('all')
  creatorId?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'retired'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;
}
