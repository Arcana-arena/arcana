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

  @Column({ name: 'creator_id', type: 'uuid' })
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

  /**
   * The rendered mandate the decision engine reads. Produced by a template
   * (see mandate-templates.ts), never typed by a user — but nullable and TEXT,
   * because agents created before phase 12 have none and the built-in
   * deterministic strategies never will.
   */
  @Column({ type: 'text', nullable: true })
  mandate: string | null;

  @Column({ name: 'mandate_template', type: 'varchar', length: 64, nullable: true })
  mandateTemplate: string | null;

  @Column({ name: 'mandate_params', type: 'jsonb', nullable: true })
  mandateParams: Record<string, string | number> | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: string; // draft, active, retired

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
