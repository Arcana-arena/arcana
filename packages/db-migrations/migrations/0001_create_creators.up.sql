-- 0001_create_creators.up.sql
-- ARCANA creators table, per docs/architecture.md §7.

CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle VARCHAR(50) UNIQUE NOT NULL,
  wallet_address VARCHAR(64) UNIQUE,
  reputation_score NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  status VARCHAR(20) DEFAULT 'active' -- active, suspended, banned
);
