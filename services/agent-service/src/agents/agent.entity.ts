import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('agents')
@Unique(['creatorId', 'name', 'version'])
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index('idx_agents_creator')
  creatorId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ name: 'parent_agent_id', type: 'uuid', nullable: true })
  parentAgentId: string | null;

  @Column({ name: 'strategy_type', type: 'varchar', length: 50, nullable: true })
  strategyType: string | null;

  @Column({ name: 'risk_profile', type: 'jsonb' })
  riskProfile: Record<string, unknown>;

  @Column({ name: 'asset_universe', type: 'varchar', length: 30 })
  assetUniverse: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: string; // draft, active, retired

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
