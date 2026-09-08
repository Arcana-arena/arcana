import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('deposit_addresses')
export class DepositAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_wallet', type: 'varchar', length: 64 })
  userWallet: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  @Column({ name: 'derived_address', type: 'varchar', length: 64, unique: true })
  derivedAddress: string;

  @Column({ name: 'derivation_path', type: 'varchar', length: 100 })
  derivationPath: string;

  @Column({ name: 'expected_amount', type: 'numeric', precision: 20, scale: 8 })
  expectedAmount: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // pending, received, swept, expired_unpaid

  /**
   * Chain height when this address was handed to the user (migration 0016).
   * The listener never starts a scan above the oldest pending row's height, so
   * a transfer made right after issuance can never fall below the scan floor.
   * NULL for rows created before 0016 — those are skipped by the clamp.
   */
  @Column({ name: 'created_at_block', type: 'bigint', nullable: true })
  createdAtBlock: string | null;
}
