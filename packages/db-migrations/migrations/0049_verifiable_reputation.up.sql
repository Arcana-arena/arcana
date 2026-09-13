-- 0049_verifiable_reputation.up.sql
-- A score anybody can compute again, not only a score nobody changed.
--
-- WHY ANCHORING THE SCORE ALONE IS NOT ENOUGH. A root on chain for 72.0 proves
-- the number was not edited afterwards. It does not prove 72.0 is what the data
-- gives: a reader still has to trust the arithmetic. A reputation is checkable
-- when it can be RECOMPUTED — the inputs are available and sealed, the formula
-- and its weights are published with the score, and anyone arrives at the same
-- number on their own.
--
-- So, in this order:
--   1. Every portfolio snapshot is sealed when it is written, and its seal is
--      anchored on chain through the same anchor job as decisions. The NAV
--      series is what performance, risk, consistency and longevity are
--      computed from; without it sealed, a recomputation proves nothing.
--   2. Every score snapshot is written with a manifest naming its formula
--      version, every constant and weight in force, every input it read (each
--      with its seal), and every output. The manifest is a content-addressed
--      body like a decision's; its sha256 is the score's seal.
--   3. A score's seal joins an anchor only once every sealed input it names is
--      already in a mined anchor. The root then seals a number anybody can
--      recompute from data that is itself on chain.
--
-- NOTHING OLD IS SEALED. Snapshots and scores written before this migration
-- stay unsealed, for the reason decisions before 0047 carry no commitment: a
-- seal computed today for last week's row proves nothing about last week. A
-- score whose NAV series starts before sealing says how many of its inputs are
-- sealed rather than implying all of them are.
--
-- THE FORMULA IS NOT CHANGED. See services/scoring-engine/internal/engine.

-- --------------------------------------------------------------------------
-- 1. Portfolio snapshots, sealed.
-- --------------------------------------------------------------------------
ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS seal CHAR(64),
  ADD COLUMN IF NOT EXISTS seal_scheme VARCHAR(40);

COMMENT ON COLUMN portfolio_snapshots.seal IS
  'sha256 of the snapshot manifest (decision_evidence kind=portfolio_manifest) written in the '
  'same transaction: portfolio, agent, season, ts, nav, cash, holdings and the previous seal of '
  'this portfolio. NULL for every snapshot written before 0049; never backfilled.';

-- A sealed snapshot cannot be edited or deleted, and a seal cannot be added to an
-- old one. Verification fixtures are exempt: they are never anchored, the sweep
-- that made them deletes them, and cost-budget-verify pins a fixture's capital.
-- A fixture's provenance is itself frozen by 0042, so a real agent cannot be
-- relabelled to qualify.
CREATE OR REPLACE FUNCTION portfolio_snapshot_is_sealed() RETURNS trigger AS $$
DECLARE
  fixture boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM portfolios p JOIN agents a ON a.id = p.agent_id
     WHERE p.id = OLD.portfolio_id AND a.provenance = 'verification') INTO fixture;

  IF TG_OP = 'DELETE' THEN
    IF OLD.seal IS NOT NULL AND NOT fixture THEN
      RAISE EXCEPTION 'portfolio snapshot % at % is sealed by % and cannot be deleted',
        OLD.portfolio_id, OLD.ts, OLD.seal
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF fixture THEN
    RETURN NEW;
  END IF;

  IF OLD.seal IS NULL THEN
    IF NEW.seal IS NOT NULL OR NEW.seal_scheme IS NOT NULL THEN
      RAISE EXCEPTION
        'a seal is written in the same statement as its snapshot and is never added afterwards (portfolio % at %)',
        OLD.portfolio_id, OLD.ts
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.seal, NEW.seal_scheme, NEW.portfolio_id, NEW.ts, NEW.holdings, NEW.nav, NEW.cash)
     IS DISTINCT FROM
     (OLD.seal, OLD.seal_scheme, OLD.portfolio_id, OLD.ts, OLD.holdings, OLD.nav, OLD.cash) THEN
    RAISE EXCEPTION 'portfolio snapshot % at % is sealed by %: nothing it sealed can be changed',
      OLD.portfolio_id, OLD.ts, OLD.seal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_snapshots_sealed ON portfolio_snapshots;
CREATE TRIGGER portfolio_snapshots_sealed BEFORE UPDATE OR DELETE ON portfolio_snapshots
  FOR EACH ROW EXECUTE FUNCTION portfolio_snapshot_is_sealed();

-- --------------------------------------------------------------------------
-- 2. Score snapshots, sealed, with the inputs they name.
-- --------------------------------------------------------------------------
ALTER TABLE score_snapshots
  ADD COLUMN IF NOT EXISTS seal CHAR(64),
  ADD COLUMN IF NOT EXISTS seal_scheme VARCHAR(40);

COMMENT ON COLUMN score_snapshots.seal IS
  'sha256 of the score manifest (decision_evidence kind=score_manifest) written in the same '
  'transaction: formula version, every constant and weight, every input with its seal, every '
  'output, and the previous seal for this agent and season. NULL before 0049; never backfilled.';

CREATE OR REPLACE FUNCTION score_snapshot_is_sealed() RETURNS trigger AS $$
DECLARE
  fixture boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.provenance = 'verification')
    INTO fixture;

  IF TG_OP = 'DELETE' THEN
    IF OLD.seal IS NOT NULL AND NOT fixture THEN
      RAISE EXCEPTION 'score snapshot of agent % at % is sealed by % and cannot be deleted',
        OLD.agent_id, OLD.ts, OLD.seal
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF fixture THEN
    RETURN NEW;
  END IF;

  IF OLD.seal IS NULL THEN
    IF NEW.seal IS NOT NULL OR NEW.seal_scheme IS NOT NULL THEN
      RAISE EXCEPTION
        'a seal is written in the same statement as its score and is never added afterwards (agent % at %)',
        OLD.agent_id, OLD.ts
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.seal, NEW.seal_scheme, NEW.agent_id, NEW.season_id, NEW.ts, NEW.arcana_score,
      NEW.performance_score, NEW.risk_score, NEW.strategy_score, NEW.regime_score,
      NEW.consistency_score, NEW.creator_score, NEW.longevity_score)
     IS DISTINCT FROM
     (OLD.seal, OLD.seal_scheme, OLD.agent_id, OLD.season_id, OLD.ts, OLD.arcana_score,
      OLD.performance_score, OLD.risk_score, OLD.strategy_score, OLD.regime_score,
      OLD.consistency_score, OLD.creator_score, OLD.longevity_score) THEN
    RAISE EXCEPTION 'score snapshot of agent % at % is sealed by %: nothing it sealed can be changed',
      OLD.agent_id, OLD.ts, OLD.seal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS score_snapshots_sealed ON score_snapshots;
CREATE TRIGGER score_snapshots_sealed BEFORE UPDATE OR DELETE ON score_snapshots
  FOR EACH ROW EXECUTE FUNCTION score_snapshot_is_sealed();

-- The sealed inputs a score names, one row each, written with the score. The
-- manifest is the authority; these rows exist so the anchor job can ask, in one
-- query, whether every input is already on chain before the score joins a root.
CREATE TABLE IF NOT EXISTS score_input_seals (
  agent_id    UUID         NOT NULL,
  season_id   UUID         NOT NULL,
  score_ts    TIMESTAMPTZ  NOT NULL,
  input_kind  VARCHAR(20)  NOT NULL CHECK (input_kind IN ('decision', 'portfolio_snapshot', 'score')),
  seal        CHAR(64)     NOT NULL,
  PRIMARY KEY (agent_id, season_id, score_ts, input_kind, seal)
);

CREATE INDEX IF NOT EXISTS idx_score_input_seals_seal ON score_input_seals (seal);

CREATE OR REPLACE FUNCTION score_input_seal_is_fixed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a score''s inputs are part of its seal and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.provenance = 'verification') THEN
    RAISE EXCEPTION 'a score''s inputs are part of its seal and cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS score_input_seals_fixed ON score_input_seals;
CREATE TRIGGER score_input_seals_fixed BEFORE UPDATE OR DELETE ON score_input_seals
  FOR EACH ROW EXECUTE FUNCTION score_input_seal_is_fixed();

-- --------------------------------------------------------------------------
-- 3. One anchor mechanism, three kinds of leaf.
-- --------------------------------------------------------------------------
-- The tree and the on-chain payload are unchanged: a leaf is still
-- sha256(0x00 || 32 bytes), and those 32 bytes are still a sha256 of a manifest.
-- What changes is which manifests: a decision commitment, a portfolio snapshot
-- seal, or a score seal. Each manifest's first line names its own scheme, so a
-- leaf never has to be told what it is. Anchors built this way are
-- arcana-anchor/v2; every v1 anchor stays exactly as it was.
ALTER TABLE decision_anchor_leaves
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'decision',
  ADD COLUMN IF NOT EXISTS portfolio_id UUID,
  ADD COLUMN IF NOT EXISTS season_id UUID,
  ADD COLUMN IF NOT EXISTS record_ts TIMESTAMPTZ;

ALTER TABLE decision_anchor_leaves ALTER COLUMN decision_id DROP NOT NULL;
ALTER TABLE decision_anchor_leaves ALTER COLUMN decision_ts DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE decision_anchor_leaves ADD CONSTRAINT anchor_leaf_kind_shape CHECK (
       (kind = 'decision'           AND decision_id IS NOT NULL AND decision_ts IS NOT NULL)
    OR (kind = 'portfolio_snapshot' AND portfolio_id IS NOT NULL AND record_ts IS NOT NULL)
    OR (kind = 'score'              AND season_id IS NOT NULL AND record_ts IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN decision_anchor_leaves.commitment IS
  'The 32 bytes this leaf hashes: a decision commitment, a portfolio snapshot seal, or a score seal (see kind).';

CREATE INDEX IF NOT EXISTS idx_anchor_leaves_commitment ON decision_anchor_leaves (commitment);
CREATE INDEX IF NOT EXISTS idx_anchor_leaves_snapshot
  ON decision_anchor_leaves (portfolio_id, record_ts) WHERE kind = 'portfolio_snapshot';
CREATE INDEX IF NOT EXISTS idx_anchor_leaves_score
  ON decision_anchor_leaves (agent_id, season_id, record_ts) WHERE kind = 'score';

-- An anchor may now carry no decision at all.
ALTER TABLE decision_anchors ALTER COLUMN first_decision_id DROP NOT NULL;
ALTER TABLE decision_anchors ALTER COLUMN last_decision_id DROP NOT NULL;
ALTER TABLE decision_anchors ALTER COLUMN first_decision_ts DROP NOT NULL;
ALTER TABLE decision_anchors ALTER COLUMN last_decision_ts DROP NOT NULL;

-- A record is anchored once, whatever its kind. Only an anchor that failed to
-- land returns its records to the queue.
CREATE OR REPLACE FUNCTION decision_anchor_leaf_is_fixed() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'anchor leaves are part of a root already written on chain and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
       SELECT 1 FROM decision_anchor_leaves l
         JOIN decision_anchors a ON a.id = l.anchor_id
        WHERE l.anchor_id <> NEW.anchor_id
          AND a.status NOT IN ('reverted', 'dropped')
          AND l.kind = NEW.kind
          AND (   (NEW.kind = 'decision' AND l.decision_id = NEW.decision_id AND l.decision_ts = NEW.decision_ts)
               OR (NEW.kind = 'portfolio_snapshot' AND l.portfolio_id = NEW.portfolio_id AND l.record_ts = NEW.record_ts)
               OR (NEW.kind = 'score' AND l.agent_id = NEW.agent_id AND l.season_id = NEW.season_id
                   AND l.record_ts = NEW.record_ts))) THEN
    RAISE EXCEPTION '% record is already in an anchor that has not failed', NEW.kind
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
