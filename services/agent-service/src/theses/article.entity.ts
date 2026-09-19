import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('articles')
export class Article {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'creator_id', type: 'uuid' })
  creatorId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /**
   * Optional, and fixed once set (trigger in 0052).
   *
   * Most articles carry no thesis. Requiring one would push creators into
   * inventing forecasts they did not want to make, and a record full of
   * throwaway claims says less than one with few.
   */
  @Column({ name: 'thesis_id', type: 'uuid', nullable: true })
  thesisId: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
