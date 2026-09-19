-- 0055_no_default_wait.down.sql
--
-- Restores the four-hour default for NEW agents only. It deliberately does not
-- push existing agents back to 14400: by the time this runs, 60 may be a number
-- an owner typed, and there is no way left to tell which rows were moved by the
-- up-migration and which were chosen. Guessing would take an owner's decision
-- away to undo a platform one.

ALTER TABLE agents ALTER COLUMN cadence_seconds SET DEFAULT 14400;
