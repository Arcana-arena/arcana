-- 0047_private_agent_public_proof.up.sql
-- PRIVATE AGENT. PUBLIC PROOF.
--
-- A creator may keep an agent's intelligence private — its mandate, its risk
-- rules, and the prompt, raw response, model and thesis behind every decision —
-- while its decisions, executions, performance, score and rank stay public.
--
-- THE PROBLEM THIS HAS TO SOLVE RATHER than step around. Since 0026 the evidence
-- behind an LLM decision has been published in full, and that publication is
-- what "verified decision history" rests on: the claim moved from REPRODUCIBLE
-- to ATTESTED, and attestation means anybody can read what was asked and what
-- came back. Hiding that for a private agent weakens the claim again unless
-- something takes the place of the evidence that is no longer shown.
--
-- WHAT TAKES ITS PLACE IS A COMMITMENT. When a decision row is written, the
-- decision engine writes a manifest naming everything that produced it — the
-- decision's own fields, the rationale, thesis, model and version, parameters,
-- and the sha256 of the system prompt, prompt and raw response — plus 32 random
-- bytes of salt and the commitment of the agent's previous decision. The
-- manifest is stored as a content-addressed evidence body (kind 'manifest', the
-- same mechanism as every other body since 0026) and its sha256 is written on
-- the decision row IN THE SAME STATEMENT. That hash is public for every agent.
--
-- Nobody can read a manifest from its hash, and the salt means nobody can find
-- it by guessing either. Anybody later shown the manifest and the bodies it
-- names can check that they are exactly what was written down when the decision
-- was made. See services/decision-engine/internal/store/commitment.go.

-- --------------------------------------------------------------------------
-- 1. The commitment, on every decision.
-- --------------------------------------------------------------------------
ALTER TABLE decisions
  -- ARCANA's own system prompt. It was sent on every LLM decision and stored
  -- nowhere; the commitment names it, so the body is kept and referenced.
  ADD COLUMN IF NOT EXISTS system_prompt_hash CHAR(64),
  -- sha256 of the manifest body in decision_evidence. NULL on every decision
  -- written before this migration, and on a decision the engine had to record
  -- without one (it logs that loudly). NULL is never backfilled: a commitment
  -- computed today for a decision made last week would prove nothing about
  -- last week.
  ADD COLUMN IF NOT EXISTS commitment CHAR(64),
  ADD COLUMN IF NOT EXISTS commitment_scheme VARCHAR(40);

COMMENT ON COLUMN decisions.commitment IS
  'sha256 of the manifest (decision_evidence kind=manifest) written with this '
  'decision: its fields, rationale, thesis, model, params, the hashes of the '
  'system prompt, prompt and raw response, the previous commitment, and a salt. '
  'Public for every agent; the manifest itself is readable only once revealed.';

-- The chain lookup: this agent's latest committed decision, in insert order.
CREATE INDEX IF NOT EXISTS idx_decisions_agent_commitment
  ON decisions (agent_id, id DESC) WHERE commitment IS NOT NULL;

-- A SEALED DECISION CANNOT BE EDITED, AND A SEAL CANNOT BE ADDED LATER.
--
-- The commitment is only worth something if what it committed to cannot move
-- underneath it, and if nobody can attach one after the price has moved. Both
-- are enforced here rather than trusted to every writer.
CREATE OR REPLACE FUNCTION decision_commitment_is_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD.commitment IS NULL THEN
    IF NEW.commitment IS NOT NULL OR NEW.commitment_scheme IS NOT NULL THEN
      RAISE EXCEPTION
        'a commitment is written in the same statement as its decision and is never added afterwards (decision % of agent %)',
        OLD.id, OLD.agent_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.commitment, NEW.commitment_scheme, NEW.system_prompt_hash, NEW.agent_id, NEW.season_id,
      NEW.ts, NEW.market_snapshot_ref, NEW.action, NEW.symbol, NEW.quantity, NEW.rationale,
      NEW.decider, NEW.reason_code, NEW.provider, NEW.model, NEW.model_version, NEW.params,
      NEW.thesis, NEW.prompt_hash, NEW.response_hash)
     IS DISTINCT FROM
     (OLD.commitment, OLD.commitment_scheme, OLD.system_prompt_hash, OLD.agent_id, OLD.season_id,
      OLD.ts, OLD.market_snapshot_ref, OLD.action, OLD.symbol, OLD.quantity, OLD.rationale,
      OLD.decider, OLD.reason_code, OLD.provider, OLD.model, OLD.model_version, OLD.params,
      OLD.thesis, OLD.prompt_hash, OLD.response_hash) THEN
    RAISE EXCEPTION
      'decision % is sealed by commitment %: nothing it committed to can be changed',
      OLD.id, OLD.commitment
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decisions_commitment_sealed ON decisions;
CREATE TRIGGER decisions_commitment_sealed BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decision_commitment_is_sealed();

-- decisions_counted was created in 0036 as `SELECT d.*`, and Postgres expands
-- `*` when a view is created, not when it is read. Without this the view — which
-- every public reader uses — would never show a commitment.
CREATE OR REPLACE VIEW decisions_counted AS
  SELECT d.*
    FROM decisions d
   WHERE NOT EXISTS (
     SELECT 1 FROM decision_artefacts a
      WHERE a.decision_id = d.id AND a.agent_id = d.agent_id AND a.decision_ts = d.ts);

-- --------------------------------------------------------------------------
-- 2. Visibility, and the record of every disclosure.
-- --------------------------------------------------------------------------
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'public';

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_visibility_valid
    CHECK (visibility IN ('public', 'private'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN agents.visibility IS
  'public: mandate, risk rules and decision evidence are published. private: they '
  'are withheld and every decision carries a commitment instead. Chosen at creation; '
  'private may become public (recorded in intelligence_disclosures), public may never '
  'become private.';

-- EVERY DISCLOSURE IS A PERMANENT RECORD: who opened what, and when.
--
-- scope 'agent'    — the whole agent became public, forever.
-- scope 'decision' — the manifest and bodies behind one decision were opened.
CREATE TABLE IF NOT EXISTS intelligence_disclosures (
  id                  BIGSERIAL PRIMARY KEY,
  agent_id            UUID NOT NULL REFERENCES agents(id),
  scope               VARCHAR(10) NOT NULL CHECK (scope IN ('agent', 'decision')),
  decision_id         BIGINT,
  decision_ts         TIMESTAMPTZ,
  -- The commitment that was opened, copied so the record stands on its own.
  commitment          CHAR(64),
  disclosed_by_wallet VARCHAR(42) NOT NULL,
  creator_id          UUID NOT NULL,
  disclosed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The transaction that wrote this row. A visibility change is refused unless
  -- a disclosure was written in the same transaction; see below.
  txid                BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT disclosure_scope_shape CHECK (
    (scope = 'decision' AND decision_id IS NOT NULL AND decision_ts IS NOT NULL)
    OR (scope = 'agent' AND decision_id IS NULL AND decision_ts IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_disclosure_agent
  ON intelligence_disclosures (agent_id) WHERE scope = 'agent';
CREATE UNIQUE INDEX IF NOT EXISTS uq_disclosure_decision
  ON intelligence_disclosures (agent_id, decision_id, decision_ts) WHERE scope = 'decision';
CREATE INDEX IF NOT EXISTS idx_disclosures_agent
  ON intelligence_disclosures (agent_id, disclosed_at DESC);

COMMENT ON TABLE intelligence_disclosures IS
  'Every time a creator opened private intelligence: the whole agent, or one '
  'decision. Cannot be edited; cannot be deleted except for verification fixtures.';

-- THE FIRST TABLE IN THIS SCHEMA THAT IS ACTUALLY APPEND-ONLY.
--
-- "Append-only" has been written in comments since 0005 and enforced nowhere.
-- A disclosure record that could be deleted would let a creator un-say that
-- they ever opened something, which is the one thing the record exists to stop.
--
-- The one exception is a row belonging to a verification fixture: the sweep
-- that removes fixtures has to be able to remove this too, and a fixture's
-- provenance is itself frozen by 0042, so a real agent cannot be relabelled to
-- qualify.
CREATE OR REPLACE FUNCTION intelligence_disclosures_are_permanent() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'disclosure % is a permanent record and cannot be edited', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.provenance = 'verification') THEN
    RAISE EXCEPTION 'disclosure % is a permanent record and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS intelligence_disclosures_permanent ON intelligence_disclosures;
CREATE TRIGGER intelligence_disclosures_permanent BEFORE UPDATE OR DELETE ON intelligence_disclosures
  FOR EACH ROW EXECUTE FUNCTION intelligence_disclosures_are_permanent();

-- A decision disclosure must name a decision of that agent.
CREATE OR REPLACE FUNCTION intelligence_disclosure_names_a_decision() RETURNS trigger AS $$
BEGIN
  IF NEW.scope = 'decision' AND NOT EXISTS (
       SELECT 1 FROM decisions d
        WHERE d.id = NEW.decision_id AND d.agent_id = NEW.agent_id AND d.ts = NEW.decision_ts) THEN
    RAISE EXCEPTION 'decision % at % does not belong to agent %', NEW.decision_id, NEW.decision_ts, NEW.agent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS intelligence_disclosure_decision_exists ON intelligence_disclosures;
CREATE TRIGGER intelligence_disclosure_decision_exists BEFORE INSERT ON intelligence_disclosures
  FOR EACH ROW EXECUTE FUNCTION intelligence_disclosure_names_a_decision();

-- VISIBILITY MOVES ONE WAY, AND NEVER SILENTLY.
--
-- private -> public is allowed: it only ever adds to what can be read.
--
-- public -> private is refused. Everything a public agent published has already
-- been read, archived and used to judge it; withdrawing it would not make it
-- secret, it would only make the record look as if it had never said it — and it
-- would let a creator bury the reasoning behind a bad call after the fact.
--
-- A version inherits privacy: a new version of a private agent starts private,
-- because its template, parameters and risk rules come from the parent, and a
-- public child would publish the parent's intelligence under another id.
CREATE OR REPLACE FUNCTION agent_visibility_moves_one_way() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.visibility = 'public' AND NEW.parent_agent_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM agents p WHERE p.id = NEW.parent_agent_id AND p.visibility = 'private') THEN
      RAISE EXCEPTION 'agent % is a version of private agent %, so it starts private', NEW.id, NEW.parent_agent_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.visibility IS NOT DISTINCT FROM OLD.visibility THEN
    RETURN NEW;
  END IF;

  IF OLD.visibility = 'public' THEN
    RAISE EXCEPTION
      'agent % is public and cannot become private: what it published has already been read, and hiding it now would only make the record look as though it never said it',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM intelligence_disclosures d
        WHERE d.agent_id = NEW.id AND d.scope = 'agent' AND d.txid = txid_current()) THEN
    RAISE EXCEPTION
      'agent % cannot become public without a disclosure record written in the same transaction',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_visibility_one_way ON agents;
CREATE TRIGGER agents_visibility_one_way BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agent_visibility_moves_one_way();
