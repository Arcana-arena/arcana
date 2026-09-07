import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('creators')
export class Creator {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  handle: string;

  @Column({ name: 'wallet_address', type: 'varchar', length: 64, nullable: true, unique: true })
  walletAddress: string | null;

  @Column({ name: 'reputation_score', type: 'numeric', precision: 10, scale: 2, default: 0 })
  reputationScore: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string; // active, suspended, banned

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
