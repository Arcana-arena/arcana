import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * WHY THE BOUNDS ARE REPEATED FROM THE DATABASE and not derived from it.
 * 0056 holds the same CHECK constraints, and both layers are deliberate: the
 * database bound is what makes the rule true of the data, and this one is what
 * turns a violation into a sentence a person can act on rather than a 500 with
 * a constraint name in it. They are kept numerically identical on purpose — if
 * one is ever changed, change both in the same commit.
 */

export class CreateThreadDto {
  /** The board's slug, not its id: a slug survives a rename, an id is noise in a URL. */
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'board must be a board slug, such as "general" or "agent-reviews"',
  })
  board: string;

  @IsString()
  @Length(3, 200)
  title: string;

  @IsString()
  @Length(1, 50000)
  body: string;
}

/** A reply under a thread, or a comment under an article. Same shape, one table. */
export class CreatePostDto {
  @IsString()
  @Length(1, 20000)
  body: string;
}

export class UpdatePostDto {
  @IsString()
  @Length(1, 20000)
  body: string;
}

export class UpdateThreadDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50000)
  body?: string;

  // board is absent on purpose. Moving a thread between boards is a moderator
  // action, not an author one, and there is no moderator endpoint for it yet —
  // so the field would accept a change nobody is allowed to make.
}

export const REPORT_REASONS = ['spam', 'hate', 'harassment', 'scam', 'off_topic', 'other'] as const;

export class CreateReportDto {
  @IsIn(REPORT_REASONS as unknown as string[], {
    message: `reason must be one of: ${REPORT_REASONS.join(', ')}`,
  })
  reason: (typeof REPORT_REASONS)[number];

  /** Optional, and the only free text a reporter gets. Bounded like everything else. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  detail?: string;
}

/**
 * Hiding always carries a reason, and the reason is REQUIRED.
 *
 * A moderation action with no stated cause is indistinguishable from a
 * disagreement being removed. The reason is stored on the row and shown in the
 * placeholder the hidden content leaves behind, so the person reading the
 * thread knows what happened rather than finding a gap.
 */
export class HideDto {
  @IsString()
  @Length(3, 300)
  reason: string;
}
