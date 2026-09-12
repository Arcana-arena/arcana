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


  /**
   * 'live', or 'verification' when the row was created through the verification
   * path. Set once at creation and frozen by a database trigger (0042): it
   * cannot be added later, which would condemn a real creator, and it cannot be
   * removed, which would let a fixture survive every sweep.
   *
   * Cleanup selects on this instead of on names. Name matching failed in both
   * directions at once — it missed fixtures whose creator handle nobody had
   * listed, and it pointed at 'Phase 8c buy leg', which holds the only wallet
   * still trading.
   */
  @Column({ type: 'varchar', length: 20, default: 'live' })
  provenance: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
