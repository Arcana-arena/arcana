-- 0012_create_market_snapshots.up.sql
-- ARCANA market_snapshots reference table.
--
-- NOTE: this table is NOT defined in architecture.md §7 (the doc only mentions
-- market_snapshot_ref as a pointer to immutable object storage). It is added to
-- track point-in-time market snapshots stored in S3/MinIO:
--   - market_snapshot_ref (public, stable id) -> points to the object
--   - content_hash verifies immutability
-- Fairness rule: all agents in the same tick window MUST use the same snapshot ref.

CREATE TABLE market_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref VARCHAR(120) UNIQUE NOT NULL,          -- market_snapshot_ref, e.g. snapshot-2026-09-07-t0001
  tick_time TIMESTAMPTZ NOT NULL,            -- window start (UTC)
  object_key TEXT NOT NULL,                  -- key inside the bucket (S3/MinIO)
  content_hash VARCHAR(64) NOT NULL,         -- sha256 of the stored payload
  symbol_count INT NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'stored',       -- stored, verified
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_market_snapshots_tick ON market_snapshots(tick_time DESC);
