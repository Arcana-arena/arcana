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


  /**
   * 'live', or 'verification' when the row was created through the verification
   * path. Set once at creation and frozen by a database trigger (0042): it
   * cannot be added later, which would condemn a real agent, and it cannot be
   * removed, which would let a fixture survive every sweep.
   *
   * Cleanup selects on this instead of on names. Name matching failed in both
   * directions at once — it missed fixtures whose creator handle nobody had
   * listed, and it pointed at 'Phase 8c buy leg', which holds the only wallet
   * still trading.
   */
  @Column({ type: 'varchar', length: 20, default: 'live' })
  provenance: string;

  /**
   * 'public' or 'private'. A private agent's mandate, risk rules and decision
   * evidence are withheld; its record is not. Chosen at creation; private may
   * become public (recorded), public never becomes private — both enforced by
   * migration 0047. See src/intelligence/intelligence.ts.
   */
  @Column({ type: 'varchar', length: 10, default: 'public' })
  visibility: 'public' | 'private';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
