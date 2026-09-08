-- 0016_deposit_created_at_block.down.sql
DROP INDEX IF EXISTS idx_deposit_addresses_pending_block;
ALTER TABLE deposit_addresses DROP COLUMN IF EXISTS created_at_block;
