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
   * The mandate the decision engine reads.
   *
   * It is now either rendered from a template (no user string reaches the
   * model) or written by the owner in their own words. Which one is recorded in
   * mandateSource rather than inferred, because NULL on mandateTemplate already
   * means "predates templates" and must not quietly acquire a second meaning.
   *
   * Nullable and TEXT: agents created before phase 12 have none, and the
   * built-in deterministic strategies never will.
   */
  @Column({ type: 'text', nullable: true })
  mandate: string | null;

  @Column({ name: 'mandate_template', type: 'varchar', length: 64, nullable: true })
  mandateTemplate: string | null;

  @Column({ name: 'mandate_params', type: 'jsonb', nullable: true })
  mandateParams: Record<string, string | number> | null;

  /** 'template' | 'free' | 'legacy'. See migration 0031. */
  @Column({ name: 'mandate_source', type: 'varchar', length: 16, nullable: true })
  mandateSource: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: string; // draft, active, retired

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
