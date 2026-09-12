-- 0043_guard_closest_approach.up.sql
--
-- HOW CLOSE DID IT EVER COME.
--
-- The guard scanner reads the realizable price of every armed position every 15
-- seconds and, when nothing is crossed, logs `scan: 2 armed, 0 fired` and throws
-- the number away. So after three hours of waiting for a subscriber's take
-- profit to fire, the record could not answer the first question anyone asks:
-- how close did it get? Not approximately — at all. The price was read 700 times
-- and kept zero times, and the RPC endpoint refuses historical state, so it
-- cannot be reconstructed afterwards either.
--
-- WHY COLUMNS AND NOT A TABLE. Two guards at four reads a minute is 11,500 rows
-- a day for one open position, to answer a question whose whole content is one
-- number. The closest approach is a running minimum: it belongs on the row it
-- describes, where it cannot grow.
--
-- The scanner writes here only when the gap NARROWS, so the write rate falls
-- away by construction — a few updates in the first minutes and then, usually,
-- none. It is a high-water mark, kept low.
--
-- WHAT THE GAP IS MEASURED IN, and why it is not measured from the mid price.
-- The watcher compares against the REALIZABLE price — what the position would
-- actually fetch if sold now, which is roughly one fee-side below the pool mid
-- (execution/pool.go: `mid * (1 - fee)`). Anyone computing "how far is it" from
-- the mid will be wrong by that fee, which on a 5 bp pool is half of a 0.1%
-- level. The number stored here is the realizable gap, as a fraction of the
-- entry price, to the NEARER of the two levels.

ALTER TABLE position_guards
  ADD COLUMN IF NOT EXISTS closest_gap_pct NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS closest_price   NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS closest_side    VARCHAR(16),
  ADD COLUMN IF NOT EXISTS closest_at      TIMESTAMPTZ;

COMMENT ON COLUMN position_guards.closest_gap_pct IS
  'Smallest gap ever observed between the realizable price and the nearer level, as a fraction of entry. A running minimum, written only when it narrows.';
COMMENT ON COLUMN position_guards.closest_side IS
  'Which level the closest approach was to: take_profit or stop_loss.';
