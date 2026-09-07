-- 0010_hypertable_portfolio_snapshots.up.sql
-- Convert portfolio_snapshots to a TimescaleDB hypertable, per docs/architecture.md §7.

SELECT create_hypertable('portfolio_snapshots', 'ts');
