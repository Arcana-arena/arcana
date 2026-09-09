import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import type { AuthConfig } from '@arcana/auth';

/**
 * EIP-4361 (Sign-In with Ethereum) message verification.
 *
 * Every field this checks is checked HERE rather than delegated, because a
 * personal_sign signature proves only "this key signed these bytes". It says
 * nothing about which site the bytes were meant for, which chain they name, or
 * when they were produced — all three of those are plain text inside the
 * message that an attacker writes. So each is validated against configuration
 * explicitly:
 *
 *   domain / uri  a signature the user produced for another site cannot be
 *                 replayed here.
 *   chainId       EIP-191 signatures are not chain-bound at all. The `Chain ID`
 *                 line is a claim, not a guarantee, so it is matched against an
 *                 allowlist instead of trusted.
 *   issuedAt      bounds how old a signature may be, independent of the nonce.
 *
 * v1 verifies EOA signatures only (secp256k1 recovery). A smart-contract wallet
 * — ERC-4337 or any other — signs via EIP-1271 and WILL be rejected here. That
 * is a known, deliberate limit, recorded in docs/auth.md rather than left for a
 * user to discover; the shape of this function leaves room to add a 1271 branch
 * without disturbing the field checks.
 */

export interface VerifiedSiwe {
  /** Lowercased address recovered from the signature. */
  wallet: string;
  nonce: string;
  issuedAt: Date;
}

function siweRejected(reason: string): HttpException {
  return new HttpException(
    {
      error: {
        code: 'siwe_verification_failed',
        message: `Sign-in message rejected: ${reason}`,
        trace_id: randomUUID(),
      },
    },
    HttpStatus.UNAUTHORIZED,
  );
}

@Injectable()
export class SiweVerifier {
  private readonly logger = new Logger(SiweVerifier.name);

  /**
   * Validates every field of a SIWE message and recovers the signer.
   *
   * Does NOT consume the nonce — that is the caller's job, and it must happen
   * between this call's field checks and its signature check being trusted.
   * See AuthService.verifySignIn for the ordering and why it matters.
   */
  parseAndValidate(cfg: AuthConfig, message: string): { nonce: string; issuedAt: Date; address: string } {
    if (!cfg.siweDomain || !cfg.siweUri) {
      // Configuration fault, not a caller fault. Surfaced by the caller as 503.
      throw new Error('SIWE domain/uri not configured');
    }

    let fields: ReturnType<typeof parseSiweMessage>;
    try {
      fields = parseSiweMessage(message);
    } catch (e) {
      throw siweRejected(`not a well-formed EIP-4361 message (${String(e)})`);
    }

    if (!fields || typeof fields.address !== 'string') {
      throw siweRejected('message carries no address');
    }
    if (fields.version !== '1') {
      throw siweRejected(`unsupported EIP-4361 version ${String(fields.version)}`);
    }

    // --- who the message was addressed to ---------------------------------
    if (fields.domain !== cfg.siweDomain) {
      throw siweRejected(
        `domain ${String(fields.domain)} is not ${cfg.siweDomain} — a message ` +
          'signed for another site cannot be used here',
      );
    }
    if (fields.uri !== cfg.siweUri) {
      throw siweRejected(`uri ${String(fields.uri)} is not ${cfg.siweUri}`);
    }

    // --- which chain it claims --------------------------------------------
    if (
      typeof fields.chainId !== 'number' ||
      !cfg.allowedChainIds.includes(fields.chainId)
    ) {
      throw siweRejected(
        `chain id ${String(fields.chainId)} is not one of ` +
          `[${cfg.allowedChainIds.join(', ')}]`,
      );
    }

    // --- when it was produced ---------------------------------------------
    if (!fields.issuedAt) {
      throw siweRejected('message has no Issued At');
    }
    const issuedAt = new Date(fields.issuedAt);
    if (Number.isNaN(issuedAt.getTime())) {
      throw siweRejected('Issued At is not a valid timestamp');
    }
    const now = Date.now();
    const skewMs = cfg.issuedAtSkewSeconds * 1000;
    if (issuedAt.getTime() > now + skewMs) {
      throw siweRejected('Issued At is in the future');
    }
    if (issuedAt.getTime() < now - skewMs) {
      throw siweRejected(
        `Issued At is older than ${cfg.issuedAtSkewSeconds}s — sign a fresh message`,
      );
    }
    if (fields.expirationTime) {
      const expiry = new Date(fields.expirationTime);
      if (Number.isNaN(expiry.getTime())) {
        throw siweRejected('Expiration Time is not a valid timestamp');
      }
      if (expiry.getTime() <= now) {
        throw siweRejected('message has expired');
      }
    }
    if (fields.notBefore) {
      const notBefore = new Date(fields.notBefore);
      if (!Number.isNaN(notBefore.getTime()) && notBefore.getTime() > now) {
        throw siweRejected('message is not valid yet');
      }
    }

    if (typeof fields.nonce !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(fields.nonce)) {
      throw siweRejected('message carries no usable nonce');
    }

    return { nonce: fields.nonce, issuedAt, address: fields.address.toLowerCase() };
  }

  /**
   * Recovers the signer and confirms it is the address the message names.
   *
   * EOA only, by design — see the class docstring.
   */
  async recoverSigner(
    message: string,
    signature: string,
    claimedAddress: string,
  ): Promise<VerifiedSiwe> {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw siweRejected('signature is not a 65-byte hex string');
    }

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
    } catch (e) {
      throw siweRejected(`signature could not be recovered (${String(e)})`);
    }

    if (recovered.toLowerCase() !== claimedAddress.toLowerCase()) {
      this.logger.warn(
        `SIWE address mismatch: message claims ${claimedAddress}, signature ` +
          `recovers ${recovered.toLowerCase()}`,
      );
      throw siweRejected('signature does not match the address in the message');
    }

    return {
      wallet: recovered.toLowerCase(),
      nonce: '',
      issuedAt: new Date(),
    };
  }
}
