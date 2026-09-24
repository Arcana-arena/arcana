-- 0059_capital_mandates.up.sql
-- ARCANA CAPITAL, architecture.md §17.5: what the owner allows, and what was done.
--
-- capital_mandates is the owner's instruction for one agent in one lending
-- market. capital_actions is every supply, borrow or repay the capital decider
-- chose — including the ones refused before anything was signed — tied to the
-- decision that chose it, the way an execution is tied to a trade decision (§12).
--
-- THE BOUNDS ARE ENFORCED HERE AS WELL AS IN THE API. The API explains a
-- refusal; the database makes sure a row that breaks the rule cannot exist,
-- whichever door it came through. Three are structural:
--
--   min_health_factor >= 1.5   Morpho liquidates at 1.0. docs/go-no-go-lending.md
--                              condition 3: the oracle holds Friday's price over
--                              a weekend, so the floor must leave room for a gap,
--                              not merely clear 1.0.
--   max_borrow_usdg > 0        and it is capped again at the signer, which is the
--                              cap a mandate cannot raise (§17.6); this column
--                              can only be lower than that.
--   max_borrow_rate_bps        1..10000: a percentage of 0 or above 100 a year is
--                              a typo, not a policy.
--
-- never_sell is not checked against the allowlist here because the list lives
-- in a file the database cannot read; the API checks it, and the decider
-- refuses any sell of a listed symbol regardless.

CREATE TABLE capital_mandates (
  agent_id               UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  market_id              VARCHAR(66) NOT NULL,
  min_health_factor      NUMERIC(10, 4) NOT NULL,
  max_borrow_rate_bps    INTEGER NOT NULL,
  liquidity_trigger_usdg NUMERIC(38, 6) NOT NULL,
  max_borrow_usdg        NUMERIC(38, 6) NOT NULL,
  never_sell             TEXT[] NOT NULL DEFAULT '{}',
  -- draft: saved, not acted on. active: the decider runs it. stopped: the owner
  -- stood it down; the position stays watched (§17.4).
  status                 VARCHAR(12) NOT NULL DEFAULT 'draft',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at           TIMESTAMPTZ,
  CONSTRAINT capital_mandates_hf_ck CHECK (min_health_factor >= 1.5 AND min_health_factor <= 10),
  CONSTRAINT capital_mandates_rate_ck CHECK (max_borrow_rate_bps BETWEEN 1 AND 10000),
  CONSTRAINT capital_mandates_borrow_ck CHECK (max_borrow_usdg > 0),
  CONSTRAINT capital_mandates_trigger_ck CHECK (liquidity_trigger_usdg >= 0 AND liquidity_trigger_usdg <= max_borrow_usdg),
  CONSTRAINT capital_mandates_status_ck CHECK (status IN ('draft', 'active', 'stopped'))
);

-- THE CAPITAL DECISION LOG, AND WHY IT IS NOT THE `decisions` TABLE.
--
-- §12 asks for every decision to be recorded with its evidence; §17.3 asks for
-- the capital record to be "its own rows" and never folded into the ARCANA
-- Score. `decisions` cannot do both: the scoring engine's strategy factor
-- divides by COUNT(*) of decisions_counted, and DNA, autopsy and the overview
-- read the same view, so a borrow written there would move a trading score and
-- a trading fingerprint. So a capital decision is a row here, carrying its own
-- evidence: the mandate and the position it was taken on, the rule's reason,
-- and what Validate and the signer said.
--
-- WHAT IS RECORDED: every action the decider chose and every refusal. A hold
-- is recorded when its reason differs from the agent's previous row, so
-- "nothing to do" once a minute does not bury the rows that matter.
CREATE TABLE capital_actions (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_id       VARCHAR(66) NOT NULL,
  decider         VARCHAR(20) NOT NULL,
  kind            VARCHAR(12) NOT NULL,
  -- Whole units of the token the action moves: the collateral for supply,
  -- USDG otherwise. Zero for a hold.
  amount          NUMERIC(38, 18) NOT NULL,
  reason_code     VARCHAR(64) NOT NULL,
  why             TEXT NOT NULL,
  -- The inputs, as the decider saw them: mandate and position.
  evidence        JSONB NOT NULL,
  -- held: a hold. refused: stopped before anything was signed — by Validate
  -- or by the signer — with the code. The rest follow the executions table.
  status          VARCHAR(12) NOT NULL,
  refusal_code    VARCHAR(64),
  refusal_detail  TEXT,
  tx_hash         VARCHAR(66),
  approve_tx_hash VARCHAR(66),
  CONSTRAINT capital_actions_kind_ck CHECK (kind IN ('hold', 'supply', 'borrow', 'repay', 'deleverage')),
  CONSTRAINT capital_actions_status_ck
    CHECK (status IN ('held', 'refused', 'mined', 'reverted', 'unresolved', 'blocked')),
  CONSTRAINT capital_actions_refusal_ck CHECK (status <> 'refused' OR refusal_code IS NOT NULL)
);

CREATE INDEX idx_capital_actions_agent_ts ON capital_actions (agent_id, ts DESC);
