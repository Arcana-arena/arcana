-- ARCANA initial database setup (runs once on first Postgres container start).
-- Full schema migrations will be managed per-service; this bootstraps the
-- shared extensions and core schema used across services.

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector (Agent DNA fingerprints)
CREATE EXTENSION IF NOT EXISTS timescaledb; -- hypertables (decisions, snapshots)
