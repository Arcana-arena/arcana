import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('creators')
export class Creator {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  handle: string;

  @Column({ name: 'wallet_address', type: 'varchar', length: 64, nullable: true, unique: true })
  walletAddress: string | null;

  /**
   * When a wallet proved control of this profile via SIWE.
   *
   * NULL means nobody ever did. Every ownership check requires a non-NULL value
   * here, so a profile that predates auth cannot be driven by anyone.
   */
  @Column({ name: 'wallet_verified_at', type: 'timestamptz', nullable: true })
  walletVerifiedAt: Date | null;

  /** 'siwe' — proven by a sign-in. 'legacy_seed' — pre-auth, frozen. */
  @Column({ type: 'varchar', length: 20, default: 'siwe' })
  origin: string;

  /** Audit note for a withdrawn pre-auth wallet. Never read for access. */
  @Column({ name: 'legacy_wallet_note', type: 'text', nullable: true })
  legacyWalletNote: string | null;

  @Column({ name: 'reputation_score', type: 'numeric', precision: 10, scale: 2, default: 0 })
  reputationScore: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string; // active, suspended, banned

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
