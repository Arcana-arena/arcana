-- 0006_create_seasons_competitions.up.sql
-- ARCANA seasons + competitions tables, per docs/architecture.md §7.

CREATE TABLE seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  universe VARCHAR(30) NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  ruleset JSONB NOT NULL
);

CREATE TABLE competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID REFERENCES seasons(id),
  type VARCHAR(30) NOT NULL, -- ai_vs_ai, human_vs_ai, challenge
  participant_ids UUID[] NOT NULL,
  result JSONB,
  status VARCHAR(20) DEFAULT 'pending'
);
