import {
  IsJSON,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Note what is absent.
 *
 * `creatorId` is gone: the owner is resolved from the caller's verified session,
 * so an agent can only ever be created under the wallet that asked. Sending it
 * is now a 400 rather than a silent override, because the global ValidationPipe
 * runs with `forbidNonWhitelisted`.
 *
 * `status` is gone: a new agent is always 'draft'. Setting it to 'active' here
 * used to skip the $ARCA entitlement check and the parent-retirement that
 * activate() performs. Activation has one door now.
 */
export class CreateAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  strategyType?: string;

  @IsOptional()
  @IsJSON()
  riskProfile?: string; // JSON string; parsed into jsonb on persist

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  assetUniverse: string;

  @IsOptional()
  @IsUUID('all')
  parentAgentId?: string;

  /**
   * Which mandate template to build this agent's intent from.
   *
   * There is deliberately no field for the mandate TEXT. The text is rendered
   * by ARCANA from the template and the parameters below; accepting it would
   * make every other defence in this path decorative. A request that sends
   * `mandate` gets a 400 from the global ValidationPipe's
   * `forbidNonWhitelisted`, which is the correct answer and not a hostile one.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mandateTemplate?: string;

  /**
   * Values for the template's declared parameters. Each is checked against a
   * closed enumeration or a numeric range before anything is rendered; see
   * renderMandate(). Unknown keys are refused rather than ignored.
   */
  @IsOptional()
  @IsObject()
  mandateParams?: Record<string, unknown>;
}
