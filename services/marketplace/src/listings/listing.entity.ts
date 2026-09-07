import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('marketplace_listings')
export class MarketplaceListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'access_type', type: 'varchar', length: 30, nullable: true })
  accessType: string | null; // subscription, one_time, strategy_access

  @Column({ name: 'price_usd', type: 'numeric', precision: 10, scale: 2, nullable: true })
  priceUsd: string | null;

  @Column({ name: 'arca_gate_amount', type: 'numeric', precision: 20, scale: 8, nullable: true })
  arcaGateAmount: string | null;

  @Column({ name: 'revenue_share_creator', type: 'numeric', precision: 4, scale: 2, default: 0.8 })
  revenueShareCreator: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
