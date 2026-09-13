-- 0046_a_marketplace_somebody_can_buy_from.up.sql
--
-- The marketplace was live and nothing in it could be bought by anyone.
--
-- THE TWO REASONS, both real and both separate:
--
--   1. The only listing was for `momentum_bot`, which is RETIRED. It makes no
--      decisions, so a subscription to it would mirror nothing into a buyer's
--      wallet. Selling access to an agent that has stopped is selling nothing.
--   2. Its creator, `arcana_labs`, has no `wallet_address`. There is therefore
--      no address a buyer could pay and none the verification could check a
--      payment against — so `/quote` refuses and `claim-payment` refuses, both
--      correctly, and both after the buyer has already gone looking.
--
-- WHICH ADDRESS, AND WHY THIS ONE.
--
-- `arcana_labs` is the platform's own seed creator; its agents are run by
-- whoever operates this deployment. The one address on this machine that a
-- person has actually PROVEN control of is the operator wallet in
-- AUTH_ADMIN_WALLETS — it signs in over SIWE, which is a signature over a
-- message naming this domain, not a string somebody typed into a config file.
-- So that is the payee, and money paid for an arcana_labs agent goes to the
-- operator who runs it.
--
-- THE ADDRESS IN `legacy_wallet_note` WAS NOT USED, and must not be. Migration
-- 0023 froze `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` and recorded why: it
-- is a PUBLICLY KNOWN TEST KEY. Anybody who wanted to could sweep every
-- payment sent to it within a block. A payee nobody can steal from is the
-- entire point of naming one.
--
-- `wallet_verified_at` IS DELIBERATELY LEFT NULL. The address is proven to the
-- auth layer as an admin wallet; it has not been proven to THIS creator record
-- by a signature bound to it, and those are different claims. Stamping a
-- verification that did not happen would be exactly the kind of quiet false
-- this schema keeps removing. The payment path does not read the column — it
-- reads `wallet_address` — so nothing is gated on the difference, and the
-- creator page prints "verification date not reported", which is true.
--
-- THE PAYEE GATE IS NOT BYPASSED HERE.
--
-- `ListingsService.create()` refuses to publish a listing whose creator cannot
-- be paid, and that rule must hold for a row written by hand exactly as it
-- holds for one written by the API. So this listing is not INSERTed as a
-- literal: it is INSERT ... SELECT, and the SELECT carries the same three
-- conditions the service would have enforced —
--
--     the creator has a wallet_address        (there is somebody to pay)
--     the agent is active                     (there is something to buy)
--     the agent's provenance is 'live'        (it is not a verification row)
--
-- If any of them is false, no row is created. The migration cannot produce the
-- state it exists to remove.

BEGIN;

-- 1. The payee.
UPDATE creators
   SET wallet_address = '0x7c1bcBb528249464Db35C408845C4E2BE056597d',
       legacy_wallet_note =
         'payee set by migration 0046 to the operator wallet from AUTH_ADMIN_WALLETS, ' ||
         'which has proven itself over SIWE. superseded_wallet=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; ' ||
         'that one stays unused: it is a publicly known test key, frozen by migration 0023'
 WHERE handle = 'arcana_labs'
   AND wallet_address IS NULL;

-- 2. The listing that was for a retired agent is switched off rather than
--    deleted. It is a real row somebody created, and the record of what has
--    been offered is part of what this platform publishes; `active = false`
--    says it is not on sale, which is the fact.
UPDATE marketplace_listings l
   SET active = false
  FROM agents a
 WHERE a.id = l.agent_id
   AND a.status = 'retired'
   AND l.active;

-- 3. A listing for an agent that is actually trading, guarded by the same
--    three conditions the service applies. `reversion_v1` is arcana_labs' best
--    ranked active agent and the one with a record worth subscribing to.
INSERT INTO marketplace_listings
  (agent_id, access_type, price_usd, arca_gate_amount, revenue_share_creator, active)
SELECT a.id, 'subscription', 25.00, 25.00000000, 0.80, true
  FROM agents a
  JOIN creators c ON c.id = a.creator_id
 WHERE c.handle = 'arcana_labs'
   AND a.name = 'reversion_v1'
   AND a.version = 2
   -- The gate, restated where it is being relied on.
   AND c.wallet_address IS NOT NULL
   AND a.status = 'active'
   AND a.provenance = 'live'
   -- Idempotent: re-running must not open a second listing for the same agent.
   AND NOT EXISTS (SELECT 1 FROM marketplace_listings ml WHERE ml.agent_id = a.id);

COMMIT;
