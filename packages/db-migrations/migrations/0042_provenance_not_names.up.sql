-- 0042_provenance_not_names.up.sql
--
-- WHY THIS EXISTS. Cleanup of verification fixtures has been done by matching
-- NAMES, and one mechanism failed in both directions at once.
--
-- It missed things: infra/verify/auth-verify-cleanup.sql selects on
-- `c.handle LIKE 'verify_alice_%' OR 'verify_bob_%'`, so seven fixture agents
-- created by other suites -- creators inj_*, meter_*, r422_*, sub_* -- were
-- unreachable by any cleanup that exists.
--
-- And it threatened the opposite. The agent named `Phase 8c buy leg`, under a
-- creator named `phase8_operator`, is not a fixture at all: it holds the only
-- wallet still trading, 49 on-chain executions, and a seat in the running
-- competition. It reads exactly like a leftover from a test. A name-based
-- cleanup is one careless afternoon away from deleting the one agent holding
-- real money.
--
-- So provenance stops being inferred and starts being recorded. A row created
-- through the verification path says so, on the row, and cleanup selects on
-- that.
--
-- THE MARK IS SET ONCE AND NEVER CHANGED. Production clients do not send the
-- verification header, so live rows cannot acquire the mark by accident; and
-- the trigger below refuses to change it afterwards, in EITHER direction. That
-- second half matters as much as the first: a mark that can be added later is a
-- way to condemn a production row, and a mark that can be removed is a way for a
-- fixture to survive every sweep.

-- A NOTE ON THE NAME, because `agent_wallets.provenance` already exists (0029)
-- and answers a different question. That one records how a KEY was obtained --
-- 'derived' today -- and says nothing about whether the row is real. This one
-- records whether the ROW was created by a verification run. Same word, two
-- axes; a reader who assumes they mean the same thing will be wrong in a way
-- that matters, since one of them decides what a cleanup may delete.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS provenance VARCHAR(20) NOT NULL DEFAULT 'live';
ALTER TABLE agents   ADD COLUMN IF NOT EXISTS provenance VARCHAR(20) NOT NULL DEFAULT 'live';

ALTER TABLE creators DROP CONSTRAINT IF EXISTS creators_provenance_known;
ALTER TABLE agents   DROP CONSTRAINT IF EXISTS agents_provenance_known;
ALTER TABLE creators ADD CONSTRAINT creators_provenance_known CHECK (provenance IN ('live', 'verification'));
ALTER TABLE agents   ADD CONSTRAINT agents_provenance_known   CHECK (provenance IN ('live', 'verification'));

-- THE BACKFILL RUNS BEFORE THE TRIGGER IS CREATED, because the trigger would
-- refuse it. That ordering is deliberate and is the only moment these rows can
-- be classified: everything after this is set at INSERT and frozen.
--
-- This is a one-time judgement about rows that predate the mark, and it is
-- written down here rather than applied by hand so that it is reviewable in a
-- diff and reversible by the down migration.
--
-- TWO CONDITIONS, BOTH REQUIRED. The handle pattern alone is what already
-- failed, so it never decides anything on its own:
--
--   1. the creator's handle matches a prefix a verification suite is known to
--      mint -- an explicit list, not a wildcard, and deliberately not matching
--      `dummy_creator` or `phase8_operator`; and
--   2. nothing belonging to that creator has ever held custody or traded: no
--      agent_wallets row, no executions row, and no seat in any competition.
--
-- Condition 2 is what protects Phase 8c buy leg, and it would protect it even
-- if someone later added `phase8_` to the list in condition 1.
WITH fixture_creators AS (
  SELECT c.id
    FROM creators c
   WHERE (c.handle LIKE 'verify_alice\_%' ESCAPE '\'
       OR c.handle LIKE 'verify_bob\_%'   ESCAPE '\'
       OR c.handle LIKE 'inj\_%'          ESCAPE '\'
       OR c.handle LIKE 'meter\_%'        ESCAPE '\'
       OR c.handle LIKE 'r422\_%'         ESCAPE '\'
       OR c.handle LIKE 'sub\_%'          ESCAPE '\')
     AND NOT EXISTS (
           SELECT 1 FROM agents a
            WHERE a.creator_id = c.id
              AND (EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = a.id)
                OR EXISTS (SELECT 1 FROM executions e WHERE e.agent_id = a.id)
                OR EXISTS (SELECT 1 FROM competitions comp WHERE a.id = ANY(comp.participant_ids)))
         )
)
UPDATE creators SET provenance = 'verification'
 WHERE id IN (SELECT id FROM fixture_creators);

UPDATE agents a SET provenance = 'verification'
 WHERE a.creator_id IN (SELECT id FROM creators WHERE provenance = 'verification')
   AND NOT EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM competitions comp WHERE a.id = ANY(comp.participant_ids));

CREATE OR REPLACE FUNCTION provenance_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.provenance IS DISTINCT FROM OLD.provenance THEN
    RAISE EXCEPTION
      'provenance is recorded once, at creation, and cannot be changed (% -> % on %)',
      OLD.provenance, NEW.provenance, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creators_provenance_immutable ON creators;
DROP TRIGGER IF EXISTS agents_provenance_immutable ON agents;
CREATE TRIGGER creators_provenance_immutable BEFORE UPDATE ON creators
  FOR EACH ROW EXECUTE FUNCTION provenance_is_immutable();
CREATE TRIGGER agents_provenance_immutable BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION provenance_is_immutable();

-- Cleanup selects on this, so it is worth an index: the sweep runs at the end of
-- every verification suite.
CREATE INDEX IF NOT EXISTS idx_agents_provenance ON agents (provenance) WHERE provenance = 'verification';
CREATE INDEX IF NOT EXISTS idx_creators_provenance ON creators (provenance) WHERE provenance = 'verification';
