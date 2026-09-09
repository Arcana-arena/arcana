-- 0020_seasons_access_tier.down.sql
ALTER TABLE seasons DROP CONSTRAINT IF EXISTS seasons_access_tier_check;
ALTER TABLE seasons DROP COLUMN IF EXISTS access_tier;
