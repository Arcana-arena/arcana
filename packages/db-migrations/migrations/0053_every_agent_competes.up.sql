-- 0053_every_agent_competes.up.sql
-- An active agent holds a seat. Nothing else was ever true of a working agent,
-- and nothing enforced it.
--
-- THE BUG THIS CLOSES. `participant_ids` had three writers that REMOVE a seat
-- (retire, succession, withdrawal) and one that grants one: a competition being
-- created with the agent already listed. Every agent created after that moment
-- was active, funded, mandated — and invisible to the cadence, which iterates
-- participant_ids. Seven active agents on this database had no seat, among them
-- one a real owner created and funded the same day. No log line anywhere said
-- so, because from the cadence's point of view those agents did not exist.
--
-- Two things are needed and both are here: somewhere to record WHEN an agent
-- entered (below), and the seats themselves for the agents already waiting.

-- --------------------------------------------------------------------------
-- 1. When each agent entered.
-- --------------------------------------------------------------------------
--
-- Entry used to close at a competition's FIRST TICK. The rule protected
-- something real: standings rank by NAV, and an agent three hours into a
-- contest ranked beside one three days in is a comparison the query cannot
-- caveat. But under a continuous four-hourly cadence on a three-month season,
-- that rule closes the arena permanently four hours after the season opens. The
-- only agents that could ever compete were the ones an operator listed by hand
-- at creation.
--
-- So the comparison problem is RECORDED rather than prevented. joined_tick_index
-- is the number of ticks the competition had already run when the agent arrived:
-- 0 means it was there from the start, 36 means its record begins at the 37th.
-- The standings carry it, so a short record is visible as a short record instead
-- of being mistaken for a bad one.
CREATE TABLE IF NOT EXISTS competition_entries (
  competition_id    UUID        NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  agent_id          UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Ticks already run when this agent joined. NOT NULL: "we do not know" would
  -- be indistinguishable from 0, which is the one value that carries a claim.
  joined_tick_index INT         NOT NULL,
  CONSTRAINT competition_entries_tick_ck CHECK (joined_tick_index >= 0),
  PRIMARY KEY (competition_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_competition_entries_agent
  ON competition_entries (agent_id);

COMMENT ON TABLE competition_entries IS
  'When each agent entered each competition. Records the FIRST entry and is '
  'never rewritten: a re-entry after a withdrawal keeps the original index, '
  'because that is where this agent''s record in this contest begins. '
  'participant_ids remains the answer to who is in it NOW.';

-- --------------------------------------------------------------------------
-- 2. The agents already in participant_ids joined at tick 0.
-- --------------------------------------------------------------------------
--
-- True by construction rather than assumed: the only way into the array before
-- now was being listed when the competition was created, which is tick 0. Dated
-- from the season's start for the same reason — now() would claim they arrived
-- today, which is the one thing this table exists to get right.
INSERT INTO competition_entries (competition_id, agent_id, joined_at, joined_tick_index)
SELECT c.id, p.agent_id, coalesce(s.start_at, now()), 0
  FROM competitions c
  JOIN seasons s ON s.id = c.season_id
  CROSS JOIN LATERAL unnest(coalesce(c.participant_ids, '{}'::uuid[])) AS p(agent_id)
 WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = p.agent_id)
ON CONFLICT (competition_id, agent_id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 3. The agents that were waiting.
-- --------------------------------------------------------------------------
--
-- Every active agent with no seat in any open competition takes one in the
-- competition that is live: `running`, and inside a season that contains now.
-- AI-vs-AI wins the tie, the same rule the service applies at activation
-- (competitions/seating.ts) — one answer to "which competition", in two places
-- that must not drift.
--
-- Draft and retired agents are left alone. A draft is refused by the engine by
-- design, so seating one would write a guaranteed failure into every tick
-- forever; a retired agent has stood down. If no competition is live this
-- inserts nothing and says nothing, which is correct: there is no room to put
-- them in.
--
-- Verification fixtures are excluded for the draft's reason rather than as a
-- favour: the engine refuses a `verification` row by design, so a seat buys it a
-- failure per tick and nothing else, and the suites mint them by the dozen.
WITH live AS (
  SELECT c.id
    FROM competitions c
    JOIN seasons s ON s.id = c.season_id
   WHERE c.status = 'running'
     AND now() >= s.start_at
     AND now() <  s.end_at
   ORDER BY (c.type = 'ai_vs_ai') DESC, s.start_at DESC, c.id
   LIMIT 1
), waiting AS (
  SELECT a.id
    FROM agents a
   WHERE a.status = 'active'
     AND a.provenance <> 'verification'
     AND NOT EXISTS (
           SELECT 1 FROM competitions c
            WHERE c.status <> 'completed'
              AND a.id = ANY(coalesce(c.participant_ids, '{}'::uuid[])))
), entered AS (
  INSERT INTO competition_entries (competition_id, agent_id, joined_tick_index)
  SELECT live.id, waiting.id,
         (SELECT count(*) FROM competition_ticks t WHERE t.competition_id = live.id)
    FROM live CROSS JOIN waiting
  -- An agent that entered this competition before and withdrew keeps its
  -- original index: the seat is what it lost, not its place in the record.
  ON CONFLICT (competition_id, agent_id) DO NOTHING
  RETURNING competition_id, agent_id
)
-- Driven by `waiting`, not by `entered`: the seat is what was missing, and an
-- agent whose entry row already existed from an earlier withdrawal needs the
-- seat just as much. Every CTE here reads the same snapshot, so the two agree.
UPDATE competitions c
   SET participant_ids = coalesce(c.participant_ids, '{}'::uuid[]) ||
                         ARRAY(SELECT id FROM waiting)
 WHERE c.id = (SELECT id FROM live)
   AND EXISTS (SELECT 1 FROM waiting);
-- `entered` is not referenced above and still runs: Postgres executes a
-- data-modifying CTE exactly once whether or not the outer query reads it.
