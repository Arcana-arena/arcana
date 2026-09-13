-- 0047_private_agent_public_proof.down.sql
--
-- Removes visibility, disclosures and commitments. Destructive by nature: the
-- disclosure record and every commitment are dropped with their columns, and
-- the manifest bodies left in decision_evidence are no longer referenced.

DROP TRIGGER IF EXISTS agents_visibility_one_way ON agents;
DROP FUNCTION IF EXISTS agent_visibility_moves_one_way();

DROP TRIGGER IF EXISTS intelligence_disclosure_decision_exists ON intelligence_disclosures;
DROP FUNCTION IF EXISTS intelligence_disclosure_names_a_decision();
DROP TRIGGER IF EXISTS intelligence_disclosures_permanent ON intelligence_disclosures;
DROP FUNCTION IF EXISTS intelligence_disclosures_are_permanent();
DROP TABLE IF EXISTS intelligence_disclosures;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_visibility_valid;
ALTER TABLE agents DROP COLUMN IF EXISTS visibility;

DROP TRIGGER IF EXISTS decisions_commitment_sealed ON decisions;
DROP FUNCTION IF EXISTS decision_commitment_is_sealed();

-- The view depends on the columns being dropped, so it is rebuilt around them.
DROP VIEW IF EXISTS decisions_counted;
DROP INDEX IF EXISTS idx_decisions_agent_commitment;
ALTER TABLE decisions
  DROP COLUMN IF EXISTS commitment_scheme,
  DROP COLUMN IF EXISTS commitment,
  DROP COLUMN IF EXISTS system_prompt_hash;

CREATE VIEW decisions_counted AS
  SELECT d.*
    FROM decisions d
   WHERE NOT EXISTS (
     SELECT 1 FROM decision_artefacts a
      WHERE a.decision_id = d.id AND a.agent_id = d.agent_id AND a.decision_ts = d.ts);

COMMENT ON VIEW decisions_counted IS
  'Decisions with measurement errors excluded. Every read model that COUNTS or '
  'ANALYSES decisions reads this; `decisions` itself is the raw append-only log '
  'and is read only by things that must see everything.';
