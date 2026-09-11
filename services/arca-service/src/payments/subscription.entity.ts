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

  // WHAT A SUBSCRIPTION BUYS NOW: the agent trades for this buyer's wallet too.
  //
  // These four columns arrived in migration 0038 and were not on the entity, so
  // the one endpoint a buyer uses to list their own subscriptions could not
  // show them any of it — not the wallet they have to fund, not whether the
  // agent is actually trading for them. See docs/subscription-trading.md.

  /** Which agent trades for this subscription. From the LISTING, at purchase. */
  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId: string | null;

  /** Derived by the signer from this subscription's id. Funded by the buyer. */
  @Column({ name: 'wallet_address', type: 'varchar', length: 42, nullable: true })
  walletAddress: string | null;

  /** The BUYER's limits, not the creator's. */
  @Column({ name: 'risk_profile', type: 'jsonb', default: () => "'{}'::jsonb" })
  riskProfile: Record<string, unknown>;

  /** The buyer's own stop. Needs nobody's agreement and does not wait for expiry. */
  @Column({ name: 'trading_paused', type: 'boolean', default: false })
  tradingPaused: boolean;
}
