import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  assertAgentOwnership,
  authUnavailable,
  resolveAgentOwnership,
} from '@arcana/auth';

/**
 * "Is this agent yours?" for the marketplace.
 *
 * Listing an agent, and editing that listing, are owner actions: a listing is a
 * public claim about someone's track record and a route to their revenue share.
 * Before auth, anyone could list anyone's agent.
 *
 * The rule is NOT reimplemented here. It is imported from @arcana/auth, the
 * same function agent-service calls, because this codebase has already seen
 * what a second copy of an access rule does — the marketplace's own duplicate
 * of the listing-access rule drifted and denied paying users for a whole grace
 * window.
 */
@Injectable()
export class ListingOwnershipService {
  private readonly logger = new Logger(ListingOwnershipService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private runner = (sql: string, params: unknown[]) => this.db.query(sql, params);

  /** Throws unless `wallet` owns `agentId`. */
  async assertOwnsAgent(wallet: string, agentId: string): Promise<void> {
    let ownership;
    try {
      ownership = await resolveAgentOwnership(this.runner, agentId);
    } catch (e) {
      throw this.lookupFailed('agent ownership lookup', e);
    }
    if (!ownership.found) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    assertAgentOwnership(ownership, wallet, agentId);
  }

  /** Throws unless `wallet` owns the agent behind `listingId`. */
  async assertOwnsListing(wallet: string, listingId: string): Promise<void> {
    let rows: Array<{ agent_id: string }>;
    try {
      rows = await this.db.query(
        `SELECT agent_id FROM marketplace_listings WHERE id = $1`,
        [listingId],
      );
    } catch (e) {
      throw this.lookupFailed('listing lookup', e);
    }
    if (rows.length === 0) {
      throw new NotFoundException(`Listing ${listingId} not found`);
    }
    await this.assertOwnsAgent(wallet, rows[0].agent_id);
  }

  /**
   * An unanswerable ownership question is 503, never a guess in either
   * direction — the same rule the entitlement client applies with its 502.
   */
  private lookupFailed(what: string, e: unknown) {
    this.logger.error(`${what} failed: ${String(e)}`);
    return authUnavailable(`${what} failed against the database`);
  }
}
