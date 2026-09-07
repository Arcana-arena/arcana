import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('competition_ticks')
@Unique(['competitionId', 'tickIndex'])
export class CompetitionTick {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'competition_id', type: 'uuid' })
  competitionId: string;

  @Column({ name: 'tick_index', type: 'int' })
  tickIndex: number;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  phase: string; // open, closed

  @Column({ name: 'market_snapshot_ref', type: 'varchar', length: 120 })
  marketSnapshotRef: string;

  @Column({ name: 'window_start', type: 'timestamptz', default: () => 'now()' })
  windowStart: Date;

  @Column({ name: 'window_end', type: 'timestamptz', nullable: true })
  windowEnd: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
