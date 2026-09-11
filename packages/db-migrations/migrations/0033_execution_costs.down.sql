-- 0033_execution_costs.down.sql
DROP INDEX IF EXISTS idx_executions_agent_cost;
ALTER TABLE executions
  DROP COLUMN IF EXISTS pool_fee_units,
  DROP COLUMN IF EXISTS pool_fee_usd,
  DROP COLUMN IF EXISTS gas_cost_usd,
  DROP COLUMN IF EXISTS eth_usd,
  DROP COLUMN IF EXISTS fee_tier;
