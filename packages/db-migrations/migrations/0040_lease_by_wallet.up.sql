-- 0040_lease_by_wallet.up.sql
-- The execution lease is keyed by WALLET, not by agent.
--
-- WHAT THE LEASE IS FOR. It stops one intent becoming two transactions: the
-- decision cycle and the position guard both want to sell the same position,
-- and whichever asks second must stand down rather than queue. That is a fact
-- about AN ACCOUNT — two writers reaching for the same balance — and it was
-- keyed by agent only because, until subscriptions traded, an agent had exactly
-- one account.
--
-- IT NOW HAS SEVERAL. One decision reaches the creator's wallet and one wallet
-- per subscriber. Keying by agent would have two wrong consequences at once:
--
--   * one subscriber's exit would block every other subscriber's, and block the
--     creator's — wallets that share nothing but an agent id serialising behind
--     each other for no reason;
--   * and worse, the fan-out holds the agent's lease for the whole tick, so a
--     subscriber's stop loss could never fire while the agent was trading for
--     anybody at all.
--
-- So the key becomes the SIGNER IDENTITY: the opaque id the signer derives a
-- wallet from. That is the agent id for a creator's position and the
-- subscription id for a buyer's, and it is exactly one wallet either way —
-- which is what the lease was always about.
--
-- THE FOREIGN KEY IS WHAT HAS TO GO. A subscription id is a UUID and is not in
-- `agents`, so the constraint would reject every subscriber lease. Dropping it
-- loses referential checking on this column; that is accepted deliberately,
-- because a lease is ephemeral by construction — it expires on its own, it is
-- deleted on release, and nothing reads it after it lapses. There is no history
-- here to keep consistent.
ALTER TABLE agent_execution_leases
  DROP CONSTRAINT IF EXISTS agent_execution_leases_agent_id_fkey;

COMMENT ON COLUMN agent_execution_leases.agent_id IS
  'The SIGNER IDENTITY whose wallet is being moved: an agent id for a '
  'creator''s position, a subscription id for a buyer''s. Not a foreign key: a '
  'subscription is not an agent, and one decision reaching several wallets must '
  'take one lease per wallet rather than one lease for all of them.';

COMMENT ON TABLE agent_execution_leases IS
  'Exclusive right to move ONE WALLET''s funds. Held by the decision cycle for '
  'the length of a tick and by the position guard for the length of an exit. '
  'Expires on its own so a crashed holder blocks nothing.';
