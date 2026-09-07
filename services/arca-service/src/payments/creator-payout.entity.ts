import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('creator_payouts')
export class CreatorPayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  @Column({ name: 'period_start', type: 'timestamptz', nullable: true })
  periodStart: Date | null;

  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd: Date | null;

  @Column({ name: 'total_amount', type: 'numeric', precision: 20, scale: 8, nullable: true })
  totalAmount: string | null;

  @Column({ name: 'tx_hash', type: 'varchar', length: 80, nullable: true })
  txHash: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // pending, paid
}
