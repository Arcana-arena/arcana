import { IsBoolean } from 'class-validator';

/**
 * The creator's decision about one agent's arbitrage, explicit.
 *
 * `enabled` is required and must be a boolean: omitting it is a 400, not a
 * false. A field that defaults when absent is how a switch about somebody's
 * funds ends up in a state nobody chose.
 */
export class ArbitrageSettingDto {
  @IsBoolean()
  enabled!: boolean;
}
