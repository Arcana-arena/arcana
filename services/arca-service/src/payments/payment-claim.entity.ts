import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One marketplace payment, verified against the chain.
 *
 * `txHash` is UNIQUE across the whole table — not per listing. See migration
 * 0027: keyed by the pair, one payment would buy every listing a creator has.
 */
@Entity('payment_claims')
export class PaymentClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tx_hash', type: 'varchar', length: 80, unique: true })
  txHash: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  /** The `from` of the verified transfer — from the chain, never from the caller. */
  @Column({ name: 'buyer_wallet', type: 'varchar', length: 64 })
  buyerWallet: string;

  @Column({ name: 'creator_wallet', type: 'varchar', length: 64 })
  creatorWallet: string;

  @Column({ name: 'token_address', type: 'varchar', length: 64 })
  tokenAddress: string;

  /** Base units, as a decimal string. NUMERIC(78,0) covers uint256. */
  @Column({ name: 'amount', type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  @Column({ name: 'block_number', type: 'bigint' })
  blockNumber: string;

  @Column({ name: 'block_time', type: 'timestamptz' })
  blockTime: Date;

  @Column({ name: 'confirmations', type: 'int' })
  confirmations: number;

  @CreateDateColumn({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt: Date;

  @Column({ name: 'claimed_by', type: 'varchar', length: 64 })
  claimedBy: string;
}
