-- 0009_hypertable_decisions.up.sql
-- Convert decisions to a TimescaleDB hypertable, per docs/architecture.md §7.
-- Requires the timescaledb extension (installed by infra/postgres/init/00-bootstrap.sql).

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
  'decisions',
  'ts',
  partitioning_column => 'agent_id',
  number_partitions => 16
);
