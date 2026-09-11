-- 0036_decision_artefacts.up.sql
-- Measurement errors, marked rather than deleted — and one place that knows.
--
-- WHAT THIS IS FOR. Between 15:06 and 15:20 UTC on 2026-09-11 the position
-- guard recorded 56 decisions saying the same thing: a level was crossed and
-- the owner's cost budget refused the exit. The condition was real and lasted
-- fourteen minutes. The guard rescans every fifteen seconds, and each scan wrote
-- a row.
--
-- Every one of those rows is true. Together they are a measurement error: the
-- `decisions` log is what every read model counts to decide whether an agent has
-- competed, so one condition sampled 56 times makes a stuck agent look like a
-- busy one. On the affected agent it was 56 of 69 rows.
--
-- WHY MARK AND NOT DELETE. Append-only protects the record of what an agent
-- DECIDED. It does not oblige the system to keep a measurement error in the
-- count. Deleting would also destroy the evidence of the bug, which is worth
-- keeping — so the rows stay exactly as written, and a separate table says which
-- of them should not be counted and why.
--
-- The same shape this project already uses elsewhere: a compensating record
-- rather than an UPDATE, COMMENT ON TABLE for retired tables, a struck-through
-- line in the docs for retired units. The fact is added; nothing is rewritten.
--
-- THE FIRST ROW OF THE RUN IS KEPT. The refusal happened and deserves a record.
-- What it did not deserve is 56.

CREATE TABLE IF NOT EXISTS decision_artefacts (
  decision_id BIGINT      NOT NULL,
  agent_id    UUID        NOT NULL,
  decision_ts TIMESTAMPTZ NOT NULL,
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Why this row is not a decision. A code rather than free text, so a reader
  -- can tell one class of artefact from another later.
  reason      VARCHAR(60) NOT NULL,
  note        TEXT,
  PRIMARY KEY (decision_id, agent_id, decision_ts)
);

-- NO FOREIGN KEY, and that is deliberate rather than an oversight: `decisions`
-- is a TimescaleDB hypertable whose primary key is (id, agent_id, ts), and a
-- composite FK onto it would constrain chunk management for no benefit here.
-- The three columns are carried so a row can always be traced back exactly.
COMMENT ON TABLE decision_artefacts IS
  'Rows in `decisions` that are measurement errors rather than decisions. The '
  'decision rows are never modified or deleted; this table says which of them '
  'must not be counted, and why. Read models count through the '
  '`decisions_counted` view, which is the single place that knows.';

CREATE INDEX IF NOT EXISTS idx_decision_artefacts_agent
  ON decision_artefacts (agent_id);

-- --------------------------------------------------------------------------
-- ONE DEFINITION, in the database rather than in each reader.
-- --------------------------------------------------------------------------
--
-- Eight read models count decisions: the Passport, the Autopsy, Agent DNA, the
-- series endpoints, evolution, the creator listing, the competition listing,
-- and the Scoring Engine's participation rule. An exclusion installed in some
-- of them is two more definitions of what a decision is, which is the failure
-- this project keeps writing down.
--
-- So the exclusion lives here, once, and the readers select from the view. The
-- raw table stays available for anything that must see everything: auditing a
-- transaction, attaching evidence, and this table itself.
CREATE OR REPLACE VIEW decisions_counted AS
  SELECT d.*
    FROM decisions d
   WHERE NOT EXISTS (
     SELECT 1 FROM decision_artefacts a
      WHERE a.decision_id = d.id AND a.agent_id = d.agent_id AND a.decision_ts = d.ts);

COMMENT ON VIEW decisions_counted IS
  'Decisions with measurement errors excluded. Every read model that COUNTS or '
  'ANALYSES decisions reads this; `decisions` itself is the raw append-only log '
  'and is read only by things that must see everything.';

-- --------------------------------------------------------------------------
-- The 56 rows.
-- --------------------------------------------------------------------------
INSERT INTO decision_artefacts (decision_id, agent_id, decision_ts, reason, note)
SELECT d.id, d.agent_id, d.ts,
       'guard_refusal_resampled',
       'The position guard recorded this refusal once per 15-second scan while the '
       'condition held. The first row of each run is kept as the record of the '
       'refusal; these are the same condition sampled again. Fixed in the same '
       'change as this migration: the refusal is now remembered on the guard row '
       'and recorded once, restated at most daily.'
  FROM decisions d
 WHERE d.decider = 'protective'
   AND d.reason_code = 'cost_budget_exceeded'
   -- Keep the first refusal per agent. It happened, and one row says so.
   AND d.id <> (
     SELECT min(d2.id) FROM decisions d2
      WHERE d2.agent_id = d.agent_id
        AND d2.decider = 'protective'
        AND d2.reason_code = 'cost_budget_exceeded')
ON CONFLICT DO NOTHING;
