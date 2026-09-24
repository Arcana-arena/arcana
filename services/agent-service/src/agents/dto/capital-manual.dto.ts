import { IsIn, IsNumber, IsPositive, Max } from 'class-validator';

/**
 * One manual capital action. The amount is WHOLE units — NVDA for supply, USDG
 * for borrow and repay — and the engine converts it once with the allowlist's
 * decimals. What the amount is allowed to be is the engine's and the signer's
 * decision, not this shape's; the ceiling here only stops a typo of many zeros
 * from reaching them.
 */
export class CapitalManualDto {
  @IsIn(['supply', 'borrow', 'repay'])
  kind!: 'supply' | 'borrow' | 'repay';

  @IsNumber()
  @IsPositive()
  @Max(1_000_000)
  amount!: number;
}
