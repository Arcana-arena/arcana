-- 0031_mandate_source.down.sql
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_mandate_source_check;
ALTER TABLE agents DROP COLUMN IF EXISTS mandate_source;
