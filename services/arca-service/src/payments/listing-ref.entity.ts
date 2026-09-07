import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Read-only projection of marketplace_listings (shared DB, same table the
 * marketplace-service owns). Used to resolve the ARCA gate amount + creator
 * revenue share when generating a deposit address.
 */
@Entity('marketplace_listings')
export class ListingRef {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'access_type', type: 'varchar', length: 30, nullable: true })
  accessType: string | null;

  @Column({ name: 'arca_gate_amount', type: 'numeric', precision: 20, scale: 8, nullable: true })
  arcaGateAmount: string | null;

  @Column({ name: 'revenue_share_creator', type: 'numeric', precision: 4, scale: 2, default: 0.8 })
  revenueShareCreator: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
