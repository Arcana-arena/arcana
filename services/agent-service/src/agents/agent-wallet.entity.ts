import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An agent's trading wallet — the ADDRESS and who can sign for it.
 *
 * No private key and no seed is in this table, or anywhere else in this
 * database. Key material lives with the signer, in a directory the service
 * user cannot read. Putting it here would hand it to every service holding a
 * database connection and copy it into every backup archive, which is the
 * isolation that was deliberately built being deliberately undone.
 *
 * SEPARATE FROM THE LOGIN WALLET. A creator signs in with a wallet (SIWE) and
 * their agents trade from other wallets entirely. They are not the same thing
 * and must not be made the same thing: the login wallet is an identity the
 * user proves with a signature ARCANA never sees the key for, and an agent
 * wallet is an address ARCANA signs from. Collapsing them would mean signing
 * in to ARCANA hands ARCANA the ability to spend from the wallet you signed in
 * with.
 */
@Entity('agent_wallets')
export class AgentWallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'agent_id', type: 'uuid', unique: true })
  @Index('idx_agent_wallets_agent')
  agentId: string;

  @Column({ type: 'varchar', length: 42 })
  address: string;

  /** 'derived' from the platform master seed, or 'imported' by the owner. */
  @Column({ type: 'varchar', length: 16 })
  provenance: 'derived' | 'imported';

  /**
   * 'platform_only' — ARCANA is the only party who can sign.
   * 'shared'        — the owner holds the key too.
   *
   * ONE-WAY. An exported key cannot be un-exported, so nothing sets this back,
   * and the database has CHECK constraints that make the invalid combinations
   * unrepresentable rather than merely unwritten.
   */
  @Column({ name: 'key_custody', type: 'varchar', length: 16 })
  keyCustody: 'platform_only' | 'shared';

  @Column({ name: 'exported_at', type: 'timestamptz', nullable: true })
  exportedAt: Date | null;

  @Column({ name: 'imported_at', type: 'timestamptz', nullable: true })
  importedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
