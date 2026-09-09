import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  assertAgentOwnership,
  authUnavailable,
  forbiddenLegacyReadonly,
  forbiddenNotOwner,
  resolveAgentOwnership,
} from '@arcana/auth';

/**
 * The 🔒 tier: "does the signed-in wallet own this thing?"
 *
 * Kept as an explicit service call at the top of each mutating method rather
 * than a decorator, for two reasons. It needs a database read that the caller
 * is making anyway, and — more importantly — it keeps the two checks visibly
 * sequential at the call site:
 *
 *     await this.ownership.assertOwnsAgent(wallet, id);   // are you the owner?
 *     await this.entitlements.require('evolve', ...);     // do you hold $ARCA?
 *
 * They are different questions with different answers and different status
 * codes, and they must never collapse into one "is this allowed" helper. A
 * caller who owns the agent but lacks $ARCA deserves a different sentence from
 * one who holds plenty of $ARCA and is reaching for someone else's agent.
 *
 * The agent rule itself lives in @arcana/auth so marketplace applies exactly
 * the same one; this class is the agent-service entry point to it.
 */
@Injectable()
export class OwnershipService {
  private readonly logger = new Logger(OwnershipService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private runner = (sql: string, params: unknown[]) => this.db.query(sql, params);

  /**
   * The creator row a verified wallet drives, or null when it has none yet.
   * A wallet can hold a valid session without ever having created a profile.
   */
  async creatorIdForWallet(wallet: string): Promise<string | null> {
    let rows: Array<{ id: string }>;
    try {
      rows = await this.db.query(
        `SELECT id FROM creators
          WHERE lower(wallet_address) = lower($1)
            AND wallet_verified_at IS NOT NULL
            AND origin <> 'legacy_seed'`,
        [wallet],
      );
    } catch (e) {
      throw this.lookupFailed('creator lookup', e);
    }
    return rows[0]?.id ?? null;
  }

  /**
   * Throws unless `wallet` owns `agentId`. Returns the owning creator id.
   *
   * Three distinct refusals, deliberately not merged:
   *   404  the agent does not exist
   *   403 forbidden_legacy_readonly  it exists but nobody owns it (pre-auth seed)
   *   403 forbidden_not_owner        it exists, someone owns it, not you
   */
  async assertOwnsAgent(wallet: string, agentId: string): Promise<string> {
    let ownership;
    try {
      ownership = await resolveAgentOwnership(this.runner, agentId);
    } catch (e) {
      throw this.lookupFailed('agent ownership lookup', e);
    }

    if (!ownership.found) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    return assertAgentOwnership(ownership, wallet, agentId);
  }

  /** Throws unless `wallet` is the verified owner of `creatorId`. */
  async assertOwnsCreator(wallet: string, creatorId: string): Promise<void> {
    let rows: Array<{
      wallet_address: string | null;
      wallet_verified_at: Date | null;
      origin: string | null;
    }>;
    try {
      rows = await this.db.query(
        `SELECT wallet_address, wallet_verified_at, origin
           FROM creators WHERE id = $1`,
        [creatorId],
      );
    } catch (e) {
      throw this.lookupFailed('creator ownership lookup', e);
    }

    if (rows.length === 0) {
      throw new NotFoundException(`Creator ${creatorId} not found`);
    }
    const row = rows[0];

    if (row.origin === 'legacy_seed' || !row.wallet_verified_at) {
      throw forbiddenLegacyReadonly(
        `Creator ${creatorId} predates wallet authentication and has no verified ` +
          'owner. It is permanently read-only — see docs/auth.md.',
      );
    }
    if ((row.wallet_address ?? '').toLowerCase() !== wallet.toLowerCase()) {
      throw forbiddenNotOwner(`Creator ${creatorId} belongs to another wallet.`);
    }
  }

  /**
   * A failed lookup is neither an allow nor a deny.
   *
   * If the database cannot answer "who owns this", we do not get to guess.
   * Passing would hand over someone else's agent; refusing with 403 would tell
   * an owner they are not the owner. Both are confident and wrong, so this
   * raises 503 instead — the same rule the entitlement client applies with its
   * 502.
   */
  private lookupFailed(what: string, e: unknown) {
    this.logger.error(`${what} failed: ${String(e)}`);
    return authUnavailable(`${what} failed against the database`);
  }
}
