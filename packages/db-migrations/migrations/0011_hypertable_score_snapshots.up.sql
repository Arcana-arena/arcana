-- 0011_hypertable_score_snapshots.up.sql
-- Convert score_snapshots to a TimescaleDB hypertable, per docs/architecture.md §7.

SELECT create_hypertable('score_snapshots', 'ts');
