import { forbiddenLegacyReadonly, forbiddenNotOwner } from './errors';

/**
 * The canonical "who owns this agent" rule, in one place.
 *
 * Both agent-service and marketplace need it, and the temptation is for each to
 * write its own three-line join. This codebase already paid for that once: the
 * marketplace kept a second copy of the listing-access rule, it drifted from
 * arca-service's, and paying users were denied through the whole grace window.
 * So the SQL and the verdict live here and both services call them.
 *
 * Ownership requires all three:
 *   - the agent has a creator
 *   - that creator has a verified wallet (wallet_verified_at IS NOT NULL)
 *   - that creator is not a frozen pre-auth seed row
 */

/** Runs a parameterised query and returns rows. Satisfied by TypeORM's `query`. */
export type SqlRunner = (sql: string, params: unknown[]) => Promise<any[]>;

export interface AgentOwnership {
  found: boolean;
  creatorId: string | null;
  walletAddress: string | null;
  /** A wallet has proven control of the owning creator. */
  verified: boolean;
  /** The owning creator predates auth and is frozen. */
  legacy: boolean;
}

export const AGENT_OWNERSHIP_SQL = `
  SELECT a.id         AS agent_id,
         a.creator_id AS creator_id,
         c.wallet_address,
         c.wallet_verified_at,
         c.origin
    FROM agents a
    LEFT JOIN creators c ON c.id = a.creator_id
   WHERE a.id = $1
`;

export async function resolveAgentOwnership(
  run: SqlRunner,
  agentId: string,
): Promise<AgentOwnership> {
  const rows = await run(AGENT_OWNERSHIP_SQL, [agentId]);
  if (rows.length === 0) {
    return { found: false, creatorId: null, walletAddress: null, verified: false, legacy: false };
  }
  const row = rows[0];
  return {
    found: true,
    creatorId: row.creator_id ?? null,
    walletAddress: row.wallet_address ?? null,
    verified: !!row.wallet_verified_at,
    legacy: row.origin === 'legacy_seed' || !row.creator_id || !row.wallet_verified_at,
  };
}

/**
 * Turns an ownership fact into a verdict, or throws the right refusal.
 *
 * Callers handle `found === false` themselves, because "not found" is a 404 and
 * belongs to the resource, not to auth.
 */
export function assertAgentOwnership(
  ownership: AgentOwnership,
  wallet: string,
  agentId: string,
): string {
  if (ownership.legacy) {
    throw forbiddenLegacyReadonly(
      `Agent ${agentId} predates wallet authentication and has no verified ` +
        'owner. It stays readable but cannot be modified by anyone, including ' +
        'you — see docs/auth.md, "Legacy creators".',
    );
  }
  if ((ownership.walletAddress ?? '').toLowerCase() !== wallet.toLowerCase()) {
    throw forbiddenNotOwner(
      `Agent ${agentId} belongs to another wallet. Only its owner may modify it.`,
    );
  }
  return ownership.creatorId as string;
}
