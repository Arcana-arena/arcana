-- 0009_hypertable_decisions.down.sql
-- Roll back the hypertable conversion. TimescaleDB does not support converting a
-- hypertable back to a plain table in place, so this drops the hypertable.
DROP TABLE IF EXISTS decisions;
