-- ARCANA minimal dev seed.
-- Inserts 1 dummy creator, 1 dummy agent (draft), and 1 dummy season.
-- Safe to re-run: existing rows are left untouched (ON CONFLICT DO NOTHING).

BEGIN;

INSERT INTO creators (id, handle, wallet_address, reputation_score, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'dummy_creator',
  '0x0000000000000000000000000000000000000001',
  0,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (
  id, creator_id, name, version, parent_agent_id, strategy_type,
  risk_profile, asset_universe, status
)
VALUES (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'dummy_agent',
  1,
  NULL,
  'momentum',
  '{"max_risk_per_trade": 0.02, "max_drawdown": 0.2}'::jsonb,
  'us_equities',
  'draft'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO seasons (id, name, universe, start_at, end_at, ruleset)
VALUES (
  '00000000-0000-0000-0000-000000000021',
  'Dummy Season 1',
  'us_equities',
  now() - interval '30 days',
  now() + interval '60 days',
  '{"initial_capital": 100000, "rebalance": "daily"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
