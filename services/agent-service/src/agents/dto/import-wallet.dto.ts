import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * A private key the owner already controls.
 *
 * NOTE WHAT IS ABSENT: there is no `address` field. The address is derived
 * from the key by the signer and returned. If a caller could state it, the
 * wallet row would say one thing while the signer signed for another, and
 * nobody would find out until money arrived somewhere unexpected.
 *
 * The shape is checked here so a malformed key is refused before it crosses a
 * service boundary — the fewer places a key travels through, the fewer places
 * it can be logged by something that was not thinking about it. The signer
 * checks it again anyway, including that the scalar is inside the curve order,
 * because a boundary that trusts its caller is not a boundary.
 */
export class ImportWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(66)
  @Matches(/^(0[xX])?[0-9a-fA-F]{64}$/, {
    // The message names the SHAPE and never echoes the value. An error message
    // containing a private key is a private key in a log file.
    message:
      'privateKey must be 64 hexadecimal characters (32 bytes), optionally prefixed with 0x.',
  })
  privateKey: string;
}
