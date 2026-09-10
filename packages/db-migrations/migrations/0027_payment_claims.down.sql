-- 0027_payment_claims.down.sql
-- Reverting DROPS THE ANTI-REPLAY RECORD. Every verified payment is forgotten,
-- and every transaction hash that has already bought something becomes
-- claimable again — including by someone who was only watching the chain.
--
-- Back it up before running this, and revoke the subscriptions it granted, or
-- do neither and understand that both are now free to re-claim.
DROP INDEX IF EXISTS idx_payment_claims_buyer;
DROP INDEX IF EXISTS idx_payment_claims_listing;
DROP TABLE IF EXISTS payment_claims;
