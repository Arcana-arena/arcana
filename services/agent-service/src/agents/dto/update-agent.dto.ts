import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Descriptive edits only.
 *
 * `status` is deliberately not accepted. It used to be, and because update()
 * assigned it straight onto the row, `PATCH {"status":"active"}` activated an
 * agent without the $ARCA entitlement check and without retiring the parent
 * version — bypassing both invariants that activate() exists to hold.
 *
 * Lifecycle moves through the endpoints that own them:
 *   activate → POST /v1/agents/:id/activate
 *   retire   → POST /v1/agents/:id/retire
 *
 * With `forbidNonWhitelisted` on the global pipe, sending `status` here is now
 * a 400 that names the field, not a silently ignored key.
 */
export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;
}
