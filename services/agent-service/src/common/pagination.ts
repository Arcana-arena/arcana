import { BadRequestException } from '@nestjs/common';

/**
 * Pagination for the list endpoints that never had any.
 *
 * WHAT WAS ACTUALLY WRONG. `GET /v1/agents`, `/v1/creators`, `/v1/competitions`
 * and `/v1/seasons` each returned every row, unbounded, to anyone — no session
 * required, because a public track record is the product. That was fine at 7
 * agents. Phase 12 opens agent creation to users, and the failure mode of an
 * unbounded public list is not slowness: it is one request serialising the
 * whole table into memory, repeatedly, from a caller who never signed in.
 *
 * The rate limiter added in phase 12 bounds how OFTEN that can happen. It does
 * nothing about how expensive one call is, and those are different problems.
 *
 * DEFAULTS THAT DO NOT BREAK EXISTING CALLERS. A response shape change would
 * break every consumer at once, so `items` is returned alongside the fields a
 * caller needs to page, and the default page size is large enough (100) that
 * every list in the system today fits in one page. Nothing that works stops
 * working; what changes is that nothing can grow without a ceiling.
 */

export const PAGE_SIZE_DEFAULT = 100;
export const PAGE_SIZE_MAX = 500;

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  /**
   * Whether another page exists.
   *
   * Returned rather than left for the caller to compute from total, because
   * the arithmetic is off-by-one-prone and every consumer would do it
   * independently — which is how two of them end up disagreeing about whether
   * the last page exists.
   */
  has_more: boolean;
}

/**
 * Read and validate page parameters.
 *
 * REFUSES rather than clamps. A caller asking for page_size=100000 has a
 * belief about what they are getting, and silently handing them 500 rows means
 * they process a fifth of the data and never know. Same reasoning as the
 * cadence floor and the mandate parameters: an out-of-range value is a
 * question, not a preference to be quietly overruled.
 */
export function parsePage(
  page?: string,
  pageSize?: string,
): { page: number; pageSize: number; offset: number } {
  const p = page === undefined || page === '' ? 1 : Number(page);
  const s = pageSize === undefined || pageSize === '' ? PAGE_SIZE_DEFAULT : Number(pageSize);

  if (!Number.isInteger(p) || p < 1) {
    throw new BadRequestException({
      code: 'invalid_page',
      message: `page must be a whole number of at least 1; got '${String(page).slice(0, 20)}'.`,
    });
  }
  if (!Number.isInteger(s) || s < 1 || s > PAGE_SIZE_MAX) {
    throw new BadRequestException({
      code: 'invalid_page_size',
      message:
        `page_size must be a whole number between 1 and ${PAGE_SIZE_MAX}; got ` +
        `'${String(pageSize).slice(0, 20)}'. The ceiling exists because these lists are ` +
        'public and unauthenticated, so one request must not be able to serialise an ' +
        'unbounded table.',
    });
  }
  return { page: p, pageSize: s, offset: (p - 1) * s };
}

export function pageOf<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  return { items, page, page_size: pageSize, total, has_more: page * pageSize < total };
}
