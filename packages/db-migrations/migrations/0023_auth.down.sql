-- Reverse of 0023.
--
-- The withdrawn wallets are restored from `legacy_wallet_note`, which is why
-- 0023 records them in a parseable form rather than just prose. Rolling back
-- therefore returns the creators to exactly the state they were in — including
-- the publicly-known Anvil key, which is the point of a rollback being faithful
-- rather than tidy.
UPDATE creators
SET wallet_address = substring(legacy_wallet_note FROM 'withdrawn_wallet=([^;]+)')
WHERE origin = 'legacy_seed'
  AND legacy_wallet_note LIKE 'withdrawn_wallet=%';

DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS auth_nonces;

ALTER TABLE creators DROP COLUMN IF EXISTS legacy_wallet_note;
ALTER TABLE creators DROP COLUMN IF EXISTS origin;
ALTER TABLE creators DROP COLUMN IF EXISTS wallet_verified_at;
