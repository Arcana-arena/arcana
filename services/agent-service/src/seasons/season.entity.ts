import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The two arena tiers. `premium` is the one gated on $ARCA (§2.7). */
export const ACCESS_TIERS = ['standard', 'premium'] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

@Entity('seasons')
export class Season {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 30 })
  universe: string;

  @Column({ name: 'start_at', type: 'timestamptz' })
  startAt: Date;

  @Column({ name: 'end_at', type: 'timestamptz' })
  endAt: Date;

  @Column({ type: 'jsonb' })
  ruleset: Record<string, unknown>;

  /**
   * `standard` (open) or `premium` (a Premium Arena, entry gated on the $ARCA
   * `premium_arena` entitlement — see docs/premium-arena.md).
   *
   * The tier names WHICH gate applies, not how much it costs; the threshold is
   * ARCA_GATE_PREMIUM_ARENA on arca-service, with every other threshold.
   */
  @Column({ name: 'access_tier', type: 'varchar', length: 20, default: 'standard' })
  accessTier: AccessTier;
}
