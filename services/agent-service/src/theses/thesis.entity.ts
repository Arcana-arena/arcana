import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** What a benchmark may be. Prose is deliberately not an option — see 0052. */
export type BenchmarkRef =
  | { kind: 'symbol'; symbols: [string] }
  | { kind: 'basket'; symbols: string[] }
  | { kind: 'arcana_index' };

/** How the comparison is judged, fixed when the thesis is published. */
export interface ThesisCriteria {
  /** Only `gt` today. Named rather than implied so a second rule can be added
   *  without every stored row becoming ambiguous about which one it meant. */
  comparison: 'gt';
  /** Percentage points the agent must beat the benchmark by. 0 = any margin. */
  margin_pct: number;
}

@Entity('public_theses')
export class PublicThesis {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  /**
   * The agent whose performance answers the claim.
   *
   * IT IS NEVER TOLD. There is no path from this column into a prompt, a
   * mandate or a risk profile, and infra/verify/thesis-verify.mjs exists to
   * prove that by execution rather than by reading the code.
   */
  @Column({ name: 'linked_agent_id', type: 'uuid' })
  linkedAgentId: string;

  @Column({ name: 'claim_text', type: 'text' })
  claimText: string;

  @Column({ name: 'benchmark_ref', type: 'jsonb' })
  benchmarkRef: BenchmarkRef;

  @Column({ type: 'jsonb' })
  criteria: ThesisCriteria;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'resolves_at', type: 'timestamptz' })
  resolvesAt: Date;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: 'pending' | 'proven' | 'not_proven';

  /** Fractions, not percentages: 0.0312 is +3.12%. NULL until resolved. */
  @Column({ name: 'result_performance', type: 'numeric', precision: 12, scale: 6, nullable: true })
  resultPerformance: string | null;

  @Column({ name: 'result_benchmark', type: 'numeric', precision: 12, scale: 6, nullable: true })
  resultBenchmark: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** The agent's lifecycle state at resolution. Published, never acted on. */
  @Column({ name: 'agent_status_at_resolution', type: 'varchar', length: 20, nullable: true })
  agentStatusAtResolution: string | null;

  /** Every number the verdict was made from, so a reader can redo it. */
  @Column({ type: 'jsonb', nullable: true })
  measurement: Record<string, unknown> | null;
}
