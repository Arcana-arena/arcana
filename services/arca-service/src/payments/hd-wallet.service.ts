import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Derives unique per-subscription deposit addresses from one ARCANA master
 * wallet (architecture.md §10.1).
 *
 * SECURITY: the master private key MUST come from the environment / a secret
 * manager — NEVER hardcode it. In production this lives in KMS/HSM (§10.6:
 * "Private key derivasi disimpan di KMS/HSM — titik keamanan paling kritis").
 * The key is only read at process start; derived deposit keys are never
 * persisted (only the addresses + derivation paths are stored).
 *
 * Derivation: BIP-32-style. The 32-byte master private key is used as the BIP32
 * master seed, then the standard EIP-1193 account path m/44'/60'/0'/0/{index}.
 * Each subscription gets its own index — the counter is derived from the
 * highest index already recorded (see DepositAddressesService) so indexes are
 * never reused.
 */
@Injectable()
export class HdWalletService {
  private readonly logger = new Logger(HdWalletService.name);
  private readonly hd: HDKey;

  constructor(config: ConfigService) {
    const masterKey = config.get<string>('ARCA_MASTER_PRIVATE_KEY');
    if (!masterKey) {
      // The service still boots (healthz works) but deposit generation is
      // disabled until the key is configured. Production must set this via a
      // secret manager / KMS, never in the repo.
      this.logger.warn(
        'ARCA_MASTER_PRIVATE_KEY is not set — deposit address generation is disabled',
      );
      this.hd = null as unknown as HDKey;
      return;
    }
    const hex = masterKey.startsWith('0x') ? masterKey.slice(2) : masterKey;
    this.hd = HDKey.fromMasterSeed(Buffer.from(hex, 'hex'));
  }

  get enabled(): boolean {
    return this.hd != null;
  }

  /**
   * Derive the deposit address + path for a given index.
   * Returns { address, privateKey } — the private key is returned only to the
   * sweep routine at runtime and is NEVER persisted.
   */
  derive(index: number): { address: string; privateKey: `0x${string}`; path: string } {
    if (!this.hd) {
      throw new Error('ARCA_MASTER_PRIVATE_KEY not configured');
    }
    const path = `m/44'/60'/0'/0/${index}`;
    const child = this.hd.derive(path);
    if (!child.privateKey) {
      throw new Error(`no private key derived at ${path}`);
    }
    const privateKey = `0x${Buffer.from(child.privateKey).toString('hex')}` as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    return { address: account.address, privateKey, path };
  }
}
