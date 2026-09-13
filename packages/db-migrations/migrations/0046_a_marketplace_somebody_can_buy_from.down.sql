-- 0046_a_marketplace_somebody_can_buy_from.down.sql
--
-- Exact reversal, and nothing more.
--
-- The new listing is DELETED rather than deactivated: it did not exist before
-- this migration, so leaving a switched-off row behind would be inventing
-- history in the direction of tidiness. The listing 0046 switched off is turned
-- back on, because it was on.
--
-- The payee is cleared only if it is still the address 0046 set. If an operator
-- has since put a different wallet there, that is a decision this migration has
-- no business undoing — a down migration that discards somebody else's change
-- is worse than one that refuses.

BEGIN;

DELETE FROM marketplace_listings l
 USING agents a, creators c
 WHERE a.id = l.agent_id
   AND c.id = a.creator_id
   AND c.handle = 'arcana_labs'
   AND a.name = 'reversion_v1'
   AND a.version = 2
   -- Only an untouched listing: one that has been paid for is somebody's
   -- access, and deleting it would revoke what they bought.
   AND NOT EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.listing_id = l.id)
   AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.listing_id = l.id);

UPDATE marketplace_listings l
   SET active = true
  FROM agents a
 WHERE a.id = l.agent_id
   AND a.status = 'retired'
   AND NOT l.active;

UPDATE creators
   SET wallet_address = NULL,
       legacy_wallet_note =
         'withdrawn_wallet=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; reason=pre-auth seed row, ' ||
         'wallet was never proven and is a publicly known test key; frozen by migration 0023'
 WHERE handle = 'arcana_labs'
   AND wallet_address = '0x7c1bcBb528249464Db35C408845C4E2BE056597d';

COMMIT;
