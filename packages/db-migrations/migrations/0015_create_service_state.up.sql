-- 0015_create_service_state.up.sql
-- Internal key-value state for ARCANA background services.
--
-- NOTE: not in architecture.md §7 — added for operational state that needs to
-- survive restarts. The payment listener (§10.2) stores its last-processed
-- block checkpoint here so a restart backfills from that point instead of
-- rescanning from genesis.

CREATE TABLE service_state (
  service VARCHAR(50) PRIMARY KEY,
  key VARCHAR(100) NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(service, key)
);
