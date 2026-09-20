import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  assertAgentOwnership,
  authUnavailable,
  forbidden,
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

  /**
   * The creator row a wallet drives, refusing when it has none.
   *
   * WHY THIS EXISTS SEPARATELY FROM creatorIdForWallet. Every write that
   * publishes something — an article, a thesis, a thread, a reply — needs a
   * creator, and `creatorIdForWallet(...)!` was the shape in use: a non-null
   * assertion over a value that is null for every wallet that has signed in
   * without making a profile. The insert then failed on a NOT NULL constraint
   * and the caller got a 500 for the one situation the product has a page for.
   *
   * 403 and not 401: they ARE signed in. The thing they lack is a profile, and
   * the message names the form that makes one.
   */
  async creatorIdOrRefuse(wallet: string): Promise<string> {
    const id = await this.creatorIdForWallet(wallet);
    if (!id) {
      throw forbidden(
        'creator_profile_required',
        'This wallet is signed in but has no creator profile yet, and everything ' +
          'published here — agents, articles, threads, replies — belongs to one. ' +
          'Create a profile at /me and try again.',
      );
    }
    return id;
  }

  /**
   * Throws unless the creator may publish at all.
   *
   * A suspended or banned profile keeps reading — nothing published here is
   * withdrawn by a suspension, because the record is the product — and stops
   * writing. Read and write are separate questions and this only answers the
   * second one.
   */
  async assertMayPublish(creatorId: string): Promise<void> {
    let rows: Array<{ status: string }>;
    try {
      rows = await this.db.query(`SELECT status FROM creators WHERE id = $1`, [creatorId]);
    } catch (e) {
      throw this.lookupFailed('creator status lookup', e);
    }
    if (rows.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);
    if (rows[0].status !== 'active') {
      throw forbidden(
        'creator_not_active',
        `This creator profile is ${rows[0].status} and cannot publish. Existing posts stay ` +
          'readable: a suspension stops new writing, it does not erase what was said.',
      );
    }
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
