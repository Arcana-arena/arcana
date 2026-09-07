import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment_events')
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tx_hash', type: 'varchar', length: 80, unique: true })
  txHash: string;

  @Column({ name: 'deposit_address_id', type: 'uuid' })
  depositAddressId: string;

  @Column({ type: 'numeric', precision: 20, scale: 8 })
  amount: string;

  @Column({ name: 'creator_share', type: 'numeric', precision: 20, scale: 8, nullable: true })
  creatorShare: string | null;

  @Column({ name: 'platform_share', type: 'numeric', precision: 20, scale: 8, nullable: true })
  platformShare: string | null;

  @Column({ name: 'payout_status', type: 'varchar', length: 20, default: 'pending' })
  payoutStatus: string; // pending, paid, disputed
}
