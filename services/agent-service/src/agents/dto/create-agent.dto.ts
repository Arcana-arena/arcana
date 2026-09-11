import {
  IsJSON,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MANDATE_MAX_CHARS } from '../mandate-templates';

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
   * The agent's instructions, in the owner's own words.
   *
   * THIS FIELD USED TO BE REFUSED, and the refusal is now retired. The argument
   * against it was that a prompt can be jailbroken — true, and beside the
   * point, because the prompt is not where the defence lives. The decider
   * returns an INTENT; buyableQty() and applyIntent() stand between it and any
   * position; the signer accepts two named transaction shapes and no calldata,
   * so a raw transfer is not refused but unsayable; every token must already be
   * in a reviewed allowlist; size, caps, the fee floor and the cadence are all
   * outside the model's reach.
   *
   * So the most hostile mandate anybody can write commands a swap between
   * allowlisted tokens inside limits somebody else set. What it can damage is
   * that user's own capital, which is theirs to risk.
   *
   * It is fenced STRUCTURALLY rather than censored: it enters the prompt as an
   * owner instruction inside ARCANA's frame, and the output contract, the
   * symbol list and the obligation to state a thesis are restated after it. The
   * model may be told anything about STRATEGY and nothing about its CONTRACT.
   *
   * Mutually exclusive with mandateTemplate — see AgentsService.buildMandate.
   */
  @IsOptional()
  @IsString()
  // THE MESSAGE CARRIES THE REASON. class-validator rejects before the service
  // is reached, so the explanation written in AgentsService.buildMandate never
  // reached anybody — the caller got "must be shorter than or equal to 2000
  // characters" and no idea why the number is what it is. The early rejection
  // is right (a 50,000-character body should not be processed); the silence
  // about why was not.
  @MaxLength(MANDATE_MAX_CHARS, {
    message:
      `A mandate may be at most ${MANDATE_MAX_CHARS} characters. The limit is about ` +
      'inference cost, not safety: this text is sent on every decision, so a longer ' +
      'one is re-read six times a day for as long as the agent runs.',
  })
  mandate?: string;

  /**
   * Which mandate template to build this agent's intent from, for owners who
   * would rather choose than write.
   *
   * A template renders a sentence from a closed set of enumerations and numeric
   * ranges, so no string the user typed reaches the model at all. That property
   * is worth keeping even though free text is now allowed: it is a stronger
   * guarantee, and some owners want it.
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
