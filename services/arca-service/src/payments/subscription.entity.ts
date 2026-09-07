import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_wallet', type: 'varchar', length: 64 })
  userWallet: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  @Index('idx_subscriptions_expiry')
  expiresAt: Date;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string; // active, grace, expired, canceled

  @Column({ name: 'last_reminder_stage', type: 'varchar', length: 10, nullable: true })
  lastReminderStage: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
