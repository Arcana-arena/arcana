DROP TABLE IF EXISTS subscription_snapshots;
DROP INDEX IF EXISTS idx_executions_subscription;
ALTER TABLE executions
  DROP COLUMN IF EXISTS subscription_id,
  DROP COLUMN IF EXISTS wallet,
  DROP COLUMN IF EXISTS on_behalf_of;
DROP INDEX IF EXISTS idx_subscriptions_trading;
DROP INDEX IF EXISTS uq_subscriptions_wallet;
ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS wallet_address,
  DROP COLUMN IF EXISTS risk_profile,
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS trading_paused;
