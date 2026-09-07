-- 0002_create_agents.up.sql
-- ARCANA agents table, per docs/architecture.md §7.

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  parent_agent_id UUID REFERENCES agents(id), -- evolution lineage V1->V2->V3
  strategy_type VARCHAR(50),
  risk_profile JSONB NOT NULL,
  asset_universe VARCHAR(30) NOT NULL,
  status VARCHAR(20) DEFAULT 'draft', -- draft, active, retired
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(creator_id, name, version)
);

CREATE INDEX idx_agents_creator ON agents(creator_id);
CREATE INDEX idx_agents_status ON agents(status);
