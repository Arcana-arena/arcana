-- 0043_guard_closest_approach.down.sql
--
-- The high-water mark is an observation, not a derivation: dropping the columns
-- loses it, and there is nowhere else it could have been kept.

ALTER TABLE position_guards
  DROP COLUMN IF EXISTS closest_gap_pct,
  DROP COLUMN IF EXISTS closest_price,
  DROP COLUMN IF EXISTS closest_side,
  DROP COLUMN IF EXISTS closest_at;
