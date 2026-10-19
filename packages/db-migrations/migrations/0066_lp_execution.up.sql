-- 0066_lp_execution.up.sql
-- ARCANA LIQUIDITY PROVISION, execution records (phase B of the money path).
--
-- THE QUEUE GAINS THE STATES THE EXECUTOR WRITES. Until now
-- lp_position_actions had one writer (the read-only arbitrage loop) and two
-- states. Arming the executor adds a lifecycle — claimed, finished, failed —
-- and a row per intent actually sent, so "what did this proposal cause" is a
-- query rather than a journal search.
--
-- Still standalone and namespaced: no §7 core table is altered, and the only
-- foreign key is within this feature's own tables.
--
-- STANDING FIELDS, NOT REWRITTEN HISTORY: status changes in place (that is the
-- lifecycle of a queue row), and every step is kept — including a 'broadcast'
-- row whose receipt never arrived ('unresolved'), because a transaction that is
-- on the wire must remain findable.

ALTER TABLE lp_position_actions DROP CONSTRAINT lp_position_actions_status_ck;
ALTER TABLE lp_position_actions ADD CONSTRAINT lp_position_actions_status_ck
  CHECK (status IN ('proposed', 'executing', 'executed', 'failed', 'superseded'));

-- When the executor claimed it, and when it stopped. error is the first reason
-- the run stopped (a refusal code, a revert, an unresolved receipt).
ALTER TABLE lp_position_actions ADD COLUMN started_at  TIMESTAMPTZ;
ALTER TABLE lp_position_actions ADD COLUMN finished_at TIMESTAMPTZ;
ALTER TABLE lp_position_actions ADD COLUMN error       TEXT;

-- ONE ROW PER INTENT, kept current: written at broadcast with the hash and
-- again when the receipt answers. UNIQUE (action_id, step) is what makes the
-- second write an update of the first rather than a second opinion.
CREATE TABLE lp_execution_steps (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_id BIGINT NOT NULL REFERENCES lp_position_actions(id) ON DELETE CASCADE,
  step      INTEGER NOT NULL,
  intent    VARCHAR(20) NOT NULL,
  -- broadcast = signed and sent, receipt not yet read. mined/reverted are the
  -- receipt's answers. unresolved = sent, not confirmed in the wait window.
  -- refused/blocked/fault = nothing was sent; the reason is in error.
  status    VARCHAR(12) NOT NULL,
  tx_hash   VARCHAR(80),
  gas_used  VARCHAR(40),
  error     TEXT,
  CONSTRAINT lp_execution_steps_step_ck CHECK (step >= 1),
  CONSTRAINT lp_execution_steps_status_ck CHECK (status IN ('broadcast', 'mined', 'reverted', 'unresolved', 'refused', 'blocked', 'fault')),
  CONSTRAINT lp_execution_steps_uq UNIQUE (action_id, step)
);

CREATE INDEX idx_lp_execution_steps_action ON lp_execution_steps (action_id, step);
