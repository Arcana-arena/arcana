import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class VerifySiweDto {
  /** The exact EIP-4361 message that was signed, verbatim. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;

  /** 65-byte secp256k1 signature, 0x-prefixed. */
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{130}$/, {
    message: 'signature must be a 0x-prefixed 65-byte hex string',
  })
  signature!: string;
}

export class RefreshDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'refresh_token is malformed' })
  refresh_token!: string;
}
