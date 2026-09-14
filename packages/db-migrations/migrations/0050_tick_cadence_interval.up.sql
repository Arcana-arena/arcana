-- 0050_tick_cadence_interval.up.sql
-- A tick records the cadence it was opened under.
--
-- WHY. The status page judged market data "stale" after a fixed 120 minutes,
-- while the competitions tick every 4 hours. Two competitions offset by 90
-- minutes put 150 minutes between snapshots, so the page reported DEGRADED for
-- half an hour four times a day with nothing wrong. The interval that decides
-- when the next tick is due existed only as a flag on a systemd unit
-- (`cadence -interval 4h`); nothing a reader of the record could see.
--
-- So the cadence binary writes the interval it enforces onto every tick it
-- opens. "Is the next tick late?" becomes a question about the record, and a
-- second copy of the interval in another service cannot drift from it.
--
-- NULL on every tick opened before this column existed, and on ticks opened by
-- anything that does not run on an interval. NULL means "not recorded", never
-- "no cadence".

ALTER TABLE competition_ticks
  ADD COLUMN IF NOT EXISTS cadence_interval_seconds INTEGER
    CHECK (cadence_interval_seconds IS NULL OR cadence_interval_seconds >= 60);

COMMENT ON COLUMN competition_ticks.cadence_interval_seconds IS
  'The minimum time between ticks the cadence enforced when it opened this tick '
  '(cadence -interval). The next tick of this competition is due at window_start '
  'plus this. NULL = not recorded (ticks before 0050, or opened outside the cadence).';
