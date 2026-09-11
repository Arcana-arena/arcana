-- 0032_inference_usage.down.sql
DROP INDEX IF EXISTS idx_decisions_agent_day_tokens;
ALTER TABLE decisions
  DROP COLUMN IF EXISTS prompt_tokens,
  DROP COLUMN IF EXISTS completion_tokens,
  DROP COLUMN IF EXISTS cached_tokens,
  DROP COLUMN IF EXISTS latency_ms;
