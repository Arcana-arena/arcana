-- 0032_inference_usage.up.sql
-- The inference cost meter: measure what a decision cost, so it can be bounded.
--
-- WHY THIS EXISTS NOW. There was a comment in the decision engine reading
-- "Usage, for the cost meter", and fields carrying token counts parsed from
-- every provider response. There was no cost meter. No table, no column, no
-- threshold, nothing that could pause anything. The numbers were read and
-- dropped on the floor, and the comment described an intention rather than a
-- system -- which is the most expensive kind of comment, because everyone
-- downstream believes it.
--
-- It became urgent when the four-hour cadence floor was questioned. That floor
-- was doing two jobs by accident: bounding trading FEES (which it was designed
-- for, and which it does badly, because deciding is not trading) and bounding
-- INFERENCE SPEND (which nobody noticed it was doing at all). Remove it while
-- believing a cost meter exists, and an agent on a one-minute clock calls the
-- model 1,440 times a day instead of 6, with nothing in the way.
--
-- So: record the usage against the decision it belongs to, and let the engine
-- read the day's total before it spends more.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS prompt_tokens     INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cached_tokens     INTEGER,
  ADD COLUMN IF NOT EXISTS latency_ms        BIGINT;

COMMENT ON COLUMN decisions.prompt_tokens IS
  'Prompt tokens the provider reported for this decision. NULL for a decision '
  'that bought no inference at all -- a deterministic strategy, or an LLM agent '
  'whose tick was short-circuited by the rebalance band. NULL and 0 are '
  'different facts: 0 means the provider said zero, NULL means nobody asked.';

COMMENT ON COLUMN decisions.cached_tokens IS
  'Prompt tokens the provider served from its cache. Recorded separately '
  'because they are usually billed differently, and a meter that cannot tell '
  'them apart over-counts a well-cached agent.';

-- The meter reads one number per agent per day. Without this it is a sequential
-- scan of an append-only table that only grows.
CREATE INDEX IF NOT EXISTS idx_decisions_agent_day_tokens
  ON decisions (agent_id, ts)
  WHERE prompt_tokens IS NOT NULL;
