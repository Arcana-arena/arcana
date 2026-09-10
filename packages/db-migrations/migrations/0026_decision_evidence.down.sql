-- 0026_decision_evidence.down.sql
-- Reverting DESTROYS EVIDENCE. Every prompt and raw response an LLM decision
-- was based on is dropped with decision_evidence, and the decisions that cited
-- them keep their action while losing the record of how it was reached.
--
-- Those decisions do not become reproducible again by removing these columns;
-- they become unexplainable. Take a backup first if any row has a non-null
-- prompt_hash.
DROP INDEX IF EXISTS idx_decisions_reason_code;
ALTER TABLE decisions
  DROP COLUMN IF EXISTS decider,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS model_version,
  DROP COLUMN IF EXISTS params,
  DROP COLUMN IF EXISTS prompt_hash,
  DROP COLUMN IF EXISTS response_hash,
  DROP COLUMN IF EXISTS reason_code,
  DROP COLUMN IF EXISTS thesis;
ALTER TABLE agents DROP COLUMN IF EXISTS mandate;
DROP TABLE IF EXISTS decision_evidence;
