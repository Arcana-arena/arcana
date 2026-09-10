-- 0026_decision_evidence.up.sql
-- What a decision has to carry once an LLM makes it.
--
-- WHY THIS EXISTS. Until now a decision was reproducible: the same snapshot and
-- the same deterministic function give the same answer forever, so the record
-- only had to name its inputs. An LLM breaks that. The same prompt can produce
-- a different answer, and the model that produced this one will eventually be
-- withdrawn -- `deepseek-chat` was retired on 2026-07-24, while the plan naming
-- it was still being written.
--
-- So "Verified Decision History" changes meaning, from REPRODUCIBLE to
-- ATTESTED: we cannot promise the same answer again, but we can show exactly
-- what was asked, what came back, by which model, under which settings. That is
-- a weakening of the platform's central claim and is written down as one in
-- docs/on-chain-direction.md §b. These columns are the mechanism.
--
-- THE TEST THIS SCHEMA HAS TO PASS is not "can it be replayed" -- it cannot --
-- but "can a person check the reasoning later". That needs the exact prompt
-- (what the agent was told, including the prices it saw), the raw response
-- before parsing (so a malformed answer is still evidence rather than a gap),
-- and enough about the model to know what produced it.

-- --------------------------------------------------------------------------
-- 1. Evidence bodies, content-addressed.
-- --------------------------------------------------------------------------
--
-- Stored by hash, not per decision. The system prompt is identical across every
-- decision every agent ever makes, so keying by content makes it one row
-- instead of one per tick. The market context varies per tick and does not
-- dedupe -- that part is the real cost, and it is the part worth paying for.
--
-- SEPARATE TABLE, not columns on `decisions`. Two reasons. `decisions` is a
-- TimescaleDB hypertable that every read model scans; widening its rows with
-- kilobytes of text would slow every query that never looks at them. And bodies
-- belong in object storage eventually, the same as market snapshots -- keeping
-- them behind a hash means that move changes this table and nothing else.
CREATE TABLE IF NOT EXISTS decision_evidence (
  hash         CHAR(64) PRIMARY KEY,          -- sha256 of body, lowercase hex
  kind         VARCHAR(20) NOT NULL,          -- prompt | response
  body         TEXT NOT NULL,
  bytes        INT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE decision_evidence IS
  'Content-addressed prompt and raw response bodies for LLM decisions. Written '
  'once per distinct content; decisions reference it by hash. Append-only: a '
  'body is never rewritten, because the decision that cites it already '
  'happened.';

-- --------------------------------------------------------------------------
-- 2. What each decision records about how it was reached.
-- --------------------------------------------------------------------------
ALTER TABLE decisions
  -- Which decider produced this: `deterministic` (momentum / mean_reversion /
  -- buy_and_hold, kept alive), `llm`, or `human`. NULL on every row written
  -- before this migration, which is honest -- they predate the distinction.
  ADD COLUMN IF NOT EXISTS decider        VARCHAR(20),
  -- Provider and model, recorded per decision rather than read from config at
  -- display time. Config says what is running NOW; this says what ran THEN,
  -- and a year from now only the second one is evidence.
  ADD COLUMN IF NOT EXISTS provider       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS model          VARCHAR(80),
  ADD COLUMN IF NOT EXISTS model_version  VARCHAR(80),
  -- temperature, top_p, seed, max_tokens: the settings that shaped the answer.
  ADD COLUMN IF NOT EXISTS params         JSONB,
  ADD COLUMN IF NOT EXISTS prompt_hash    CHAR(64),
  ADD COLUMN IF NOT EXISTS response_hash  CHAR(64),
  -- Why a decision came out the way it did when it was not a free choice:
  -- llm_unavailable, llm_invalid_output, no_material_move, policy_refused...
  -- NULL means the decider chose freely. A hold with no reason and a hold
  -- because the provider timed out are different events and must not look alike.
  ADD COLUMN IF NOT EXISTS reason_code    VARCHAR(40),
  -- The forward-looking claim, separate from the rationale.
  --
  -- This column is the point of the whole exercise. `rationale` has always been
  -- a restatement of the rule that fired -- "momentum: AAPL up 0.26%, adding
  -- 155.79 shares" -- which says what happened, not what is expected to happen.
  -- Agent Autopsy refuses `thesis_failure` for exactly that reason: there was
  -- no claim about the future to test, and analysing one would have meant
  -- inventing it first.
  --
  -- An LLM can state a real thesis. Shape (enforced by the decision engine, not
  -- by this column):
  --   { "claim": "...", "horizon_ticks": N, "invalidated_if": "..." }
  -- `invalidated_if` is what makes it falsifiable rather than a narrative.
  ADD COLUMN IF NOT EXISTS thesis         JSONB;

COMMENT ON COLUMN decisions.reason_code IS
  'Why the decision was not a free choice: llm_unavailable, llm_invalid_output, '
  'no_material_move, policy_refused, ... NULL means the decider chose. A hold '
  'because nothing looked good and a hold because the provider timed out are '
  'different events; collapsing them is the silent failure this project refuses.';

COMMENT ON COLUMN decisions.thesis IS
  'Forward-looking, falsifiable claim: {claim, horizon_ticks, invalidated_if}. '
  'Distinct from rationale, which explains the decision at the time. This is '
  'what Agent Autopsy needs before thesis_failure can be more than invention.';

-- Reading an agent's evidence trail, and finding refusals, are both common.
CREATE INDEX IF NOT EXISTS idx_decisions_reason_code
  ON decisions (reason_code, ts DESC) WHERE reason_code IS NOT NULL;

-- --------------------------------------------------------------------------
-- 3. The user's mandate.
-- --------------------------------------------------------------------------
--
-- Agents are created from a PARAMETERISED TEMPLATE, not a free prompt: ARCANA
-- owns the system prompt and the output schema, the user supplies a bounded
-- statement of what their agent should try to do, and the risk limits stay in
-- `risk_profile` where deterministic code already enforces them.
--
-- The reason is not tidiness. A prompt can be talked out of its instructions;
-- buyableQty() cannot. So the prompt decides intent and the code decides what
-- is permitted -- a bad mandate costs its owner money through bad trades, which
-- is their risk to take, rather than through the agent doing something
-- structurally forbidden.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS mandate TEXT;

COMMENT ON COLUMN agents.mandate IS
  'The user-supplied half of a parameterised agent: a bounded statement of what '
  'this agent should try to do. Never the whole prompt -- ARCANA owns the system '
  'prompt, the output schema and the limits. Length is capped by the decision '
  'engine, which also refuses to render anything else user-controlled into the '
  'prompt: token names on a permissionless chain are attacker-written text.';
