import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The query parameters a list endpoint accepts — and, just as importantly, the
 * ones it does not.
 *
 * WHY THESE ARE CLASSES AND NOT `@Query('page')` ARGUMENTS. Reading parameters
 * one at a time means an unrecognised one is simply never read: the request
 * succeeds, the parameter does nothing, and 200 is returned. A client cannot
 * tell "sorted as you asked" from "that word means nothing here".
 *
 * That is not hypothetical. `GET /v1/agents?sort=score` answered 200 and ignored
 * it, which is what sent a frontend looking for a leaderboard that did not
 * exist. It is the same shape as an empty array that reads like data.
 *
 * The global ValidationPipe already runs with `whitelist` and
 * `forbidNonWhitelisted`, so declaring the accepted set as a DTO turns every
 * unknown parameter into a 400 that names it. Support it or refuse it; do not
 * stay quiet.
 */
/**
 * THESE DECLARE WHICH PARAMETERS EXIST. THEY DO NOT DECIDE WHAT IS VALID.
 *
 * `parsePage` in common/pagination.ts already owns the bounds — PAGE_SIZE_MAX is
 * 500, and it REFUSES rather than clamps, with a message saying what to ask for.
 * The first version of this class carried `@Max(200)`, which put a second and
 * different ceiling in a second place: `?page_size=500` started returning 400
 * while pagination.ts still said 500 was fine, and auth-verify — a legitimate
 * caller doing exactly what the documented maximum allows — broke.
 *
 * Two definitions of a limit agree on every day they still agree. So these are
 * declared as strings with no range at all: the DTO's whole job here is to make
 * an unknown parameter NAME a 400 instead of silence, and the value is handed to
 * the one function that has always judged it.
 */
export class PageQueryDto {
  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  page_size?: string;
}

export class AgentsListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsUUID('all')
  creator_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  strategy_type?: string;

  /** Free-text search over the name. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class SeasonsListQueryDto extends PageQueryDto {}

export class CompetitionsListQueryDto extends PageQueryDto {
  /**
   * SNAKE_CASE, LIKE EVERY OTHER PARAMETER IN THIS API.
   *
   * This handler used to read `seasonId`. Every other endpoint takes
   * `season_id`, `page_size`, `creator_id`, `strategy_type` — so a caller
   * following the API's own convention was filtering by a parameter nothing
   * read, and receiving EVERY competition with a 200 rather than that season's.
   * Wrong data, confidently delivered, which is worse than an error.
   *
   * `seasonId` is now refused by name rather than ignored, so an old caller is
   * told instead of quietly served the whole table.
   */
  @IsOptional()
  @IsUUID('all')
  season_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;
}

export class LeaderboardQueryDto extends PageQueryDto {
  @IsOptional()
  @IsUUID('all')
  season_id?: string;

  /**
   * Validated against the seven offered categories in the service, which owns
   * the list and the reason regime_score is not in it. Kept loose here so the
   * refusal comes from the place that can explain it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  include_unranked?: string;
}
