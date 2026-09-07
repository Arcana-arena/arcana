import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('competitions')
export class Competition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'season_id', type: 'uuid' })
  seasonId: string;

  @Column({ type: 'varchar', length: 30 })
  type: string; // ai_vs_ai, human_vs_ai, challenge

  @Column({ name: 'participant_ids', type: 'uuid', array: true })
  participantIds: string[];

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // pending, running, completed
}
