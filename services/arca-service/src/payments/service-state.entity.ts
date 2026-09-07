import { Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity('service_state')
@Unique(['service', 'key'])
export class ServiceState {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  service: string;

  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
