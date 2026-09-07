-- 0003_create_agent_dna.up.sql
-- ARCANA agent_dna table, per docs/architecture.md §7.
-- Requires the pgvector extension (installed by infra/postgres/init/00-bootstrap.sql).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_dna (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  strategy_fingerprint VECTOR(256), -- pgvector embedding of decision history
  risk_personality JSONB,
  regime_strengths JSONB,
  computed_at TIMESTAMPTZ DEFAULT now()
);
