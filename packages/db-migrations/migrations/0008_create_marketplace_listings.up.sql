-- 0008_create_marketplace_listings.up.sql
-- ARCANA marketplace_listings table, per docs/architecture.md §7.

CREATE TABLE marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  access_type VARCHAR(30), -- subscription, one_time, strategy_access
  price_usd NUMERIC(10,2),
  arca_gate_amount NUMERIC(20,8),
  revenue_share_creator NUMERIC(4,2) DEFAULT 0.80,
  active BOOLEAN DEFAULT true
);
