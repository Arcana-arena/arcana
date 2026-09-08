-- 0017_deposit_created_at.down.sql
DROP INDEX IF EXISTS idx_deposit_addresses_created_at;
ALTER TABLE deposit_addresses DROP COLUMN IF EXISTS created_at;
