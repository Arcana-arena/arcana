-- 0052_public_theses.up.sql
-- A claim a person made, before the market answered it.
--
-- WHY THIS IS NOT THE THESIS ALREADY ON EVERY DECISION. `decisions.thesis`
-- ({claim, horizon_ticks, invalidated_if}) belongs to the MODEL, is written on
-- one tick, and is judged against that tick. This one belongs to a CREATOR, is
-- written in their own words, stands on its own, and runs for days. Putting a
-- human's public claim in the decisions table would make it look like something
-- an agent decided, and a reader could no longer tell the two apart -- which is
-- the one distinction this whole feature exists to publish.
--
-- THE AGENT IS NOT TOLD. Nothing here is readable by the decision engine, and
-- that is deliberate rather than incidental: a thesis that could reach the
-- prompt would be a creator steering an agent toward proving them right, and
-- the record would be worthless. The only relationship is one-way MEASUREMENT
-- -- this table reads the agent's performance afterwards, and the agent never
-- learns it was watched. infra/verify/thesis-verify.mjs proves the negative.
--
-- LOCKED AT PUBLICATION. claim_text, benchmark_ref, criteria and resolves_at
-- are frozen by trigger the moment the row exists, for the same reason a sealed
-- decision cannot be rewritten: a prediction that can be edited after the fact
-- is not a prediction. Resolution writes the outcome columns exactly once.

-- --------------------------------------------------------------------------
-- 1. The thesis.
-- --------------------------------------------------------------------------
CREATE TABLE public_theses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  -- RESTRICT, not CASCADE. A published claim outliving its author's account is
  -- the point; deleting the creator must fail loudly rather than quietly take
  -- the record with it.
  linked_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  claim_text      TEXT NOT NULL CHECK (length(btrim(claim_text)) BETWEEN 16 AND 2000),

  -- WHAT IT IS MEASURED AGAINST, as data rather than prose.
  --   {"kind":"symbol","symbols":["SPY"]}        one instrument
  --   {"kind":"basket","symbols":["NVDA","AMD"]} equal-weighted, rebalanced never
  --   {"kind":"arcana_index"}                    market_snapshots.market_return
  -- Prose would have to be interpreted at resolution time, and interpreting is
  -- the editorial judgement this design removes.
  benchmark_ref   JSONB NOT NULL,

  -- HOW IT IS JUDGED, also as data: {"comparison":"gt","margin_pct":0}.
  -- Stored so that resolution executes a rule written before the outcome was
  -- known, by someone who did not know it.
  criteria        JSONB NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolves_at     TIMESTAMPTZ NOT NULL,

  status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'proven', 'not_proven')),

  -- Both returns as fractions (0.0312 = +3.12%), NULL until resolved.
  result_performance NUMERIC(12, 6),
  result_benchmark   NUMERIC(12, 6),
  resolved_at        TIMESTAMPTZ,

  -- The agent's lifecycle state when the measurement was taken.
  --
  -- A PAUSED OR RETIRED AGENT DOES NOT VOID THE THESIS, and this column is why
  -- it does not have to. Voiding would hand a creator watching their claim fail
  -- an escape: pause the agent, lose the record. So the measurement runs to
  -- resolves_at regardless -- an agent that stopped deciding simply stops
  -- moving -- and the state is published beside the result so a reader can see
  -- what happened without the creator being able to use it.
  agent_status_at_resolution VARCHAR(20),

  -- The arithmetic, kept: NAV endpoints, every external flow removed and why,
  -- each benchmark leg. A verdict nobody can recompute is a verdict on trust.
  measurement     JSONB,

  -- A thesis with no time to run is a coin flip dressed as a forecast; one that
  -- runs for years outlives the agent it names.
  CONSTRAINT public_theses_window CHECK (
    resolves_at >= created_at + INTERVAL '24 hours' AND
    resolves_at <= created_at + INTERVAL '365 days'),

  CONSTRAINT public_theses_resolved_together CHECK (
    (status = 'pending' AND resolved_at IS NULL AND result_performance IS NULL
       AND result_benchmark IS NULL)
    OR
    (status <> 'pending' AND resolved_at IS NOT NULL AND result_performance IS NOT NULL
       AND result_benchmark IS NOT NULL))
);

CREATE INDEX idx_public_theses_creator ON public_theses (creator_id, created_at DESC);
CREATE INDEX idx_public_theses_agent ON public_theses (linked_agent_id, created_at DESC);
-- The resolution job's only query: what is due and still pending.
CREATE INDEX idx_public_theses_due ON public_theses (resolves_at) WHERE status = 'pending';

COMMENT ON TABLE public_theses IS
  'A creator''s public market claim, bound to one of their agents and timestamped before the '
  'outcome was known. Immutable once written; resolved exactly once by the automatic job against '
  'criteria locked at publication. The linked agent is never told it was bound.';

-- --------------------------------------------------------------------------
-- 2. Immutability.
-- --------------------------------------------------------------------------
-- Enforced here and not in the service, because "cannot be edited" has to be
-- true of the database, not of one code path into it.
--
-- NO FIXTURE EXEMPTION, deliberately, and unlike 0049. An exemption keyed on
-- creators.provenance would have made the one thing this trigger exists to
-- guarantee unprovable: the verification suite could only ever have deleted a
-- row the trigger had already agreed to let go, and would have reported that
-- as proof that deletion is refused. So the refusal is unconditional and the
-- suite cleans up the way any owner would — DISABLE TRIGGER, delete, ENABLE —
-- which needs table ownership and is therefore a door the application does not
-- have. See infra/verify/thesis-verify.mjs.
CREATE OR REPLACE FUNCTION public_thesis_is_published() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'thesis % was published at % and cannot be deleted. A creator may be wrong in public; '
      'that is what publishing one costs.', OLD.id, OLD.created_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The claim and the rule that judges it never change.
  IF NEW.claim_text IS DISTINCT FROM OLD.claim_text
     OR NEW.benchmark_ref IS DISTINCT FROM OLD.benchmark_ref
     OR NEW.criteria IS DISTINCT FROM OLD.criteria
     OR NEW.resolves_at IS DISTINCT FROM OLD.resolves_at
     OR NEW.linked_agent_id IS DISTINCT FROM OLD.linked_agent_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'thesis % is published: claim, benchmark, criteria, deadline, agent and author are fixed. '
      'Only resolution may write to it.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Resolution happens once. A second pass would let a later run overwrite an
  -- outcome that has already been read and linked to.
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'thesis % already resolved % at %', OLD.id, OLD.status, OLD.resolved_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER public_theses_immutable
  BEFORE UPDATE OR DELETE ON public_theses
  FOR EACH ROW EXECUTE FUNCTION public_thesis_is_published();

-- --------------------------------------------------------------------------
-- 3. The creator's record: proven out of ALL published, never out of resolved.
-- --------------------------------------------------------------------------
-- Ten theses with three proven must not read like three with three proven, so
-- the denominator counts everything ever published -- including the ones still
-- running, which a creator cannot withdraw once they look unlikely.
--
-- reputation_score is NOT touched. It has its own formula and its own owner
-- decision behind it; a second thing writing to that column would make neither
-- number explicable.
ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS theses_published INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS theses_proven    INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN creators.theses_published IS
  'Every public thesis this creator has ever published, including pending and not_proven. '
  'Maintained by trigger, never by application code: a counter the service could set is a '
  'counter that can be set to something else.';

CREATE OR REPLACE FUNCTION public_thesis_counters() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE creators SET theses_published = theses_published + 1 WHERE id = NEW.creator_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'proven' THEN
    UPDATE creators SET theses_proven = theses_proven + 1 WHERE id = NEW.creator_id;
  ELSIF TG_OP = 'DELETE' THEN
    -- Only reachable with the immutability trigger disabled by a table owner,
    -- which is how the verification suite removes its fixtures. Counted anyway:
    -- a counter left high by a removed row would misreport the creator for good.
    UPDATE creators
       SET theses_published = GREATEST(theses_published - 1, 0),
           theses_proven = GREATEST(theses_proven - (CASE WHEN OLD.status = 'proven' THEN 1 ELSE 0 END), 0)
     WHERE id = OLD.creator_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER public_theses_count
  AFTER INSERT OR UPDATE OR DELETE ON public_theses
  FOR EACH ROW EXECUTE FUNCTION public_thesis_counters();

-- --------------------------------------------------------------------------
-- 4. Articles.
-- --------------------------------------------------------------------------
-- Writing, which MAY carry a thesis and usually will not. Kept a separate table
-- for that reason: making every article carry a claim would push creators into
-- inventing one, and a forecast nobody wanted to make is noise in the record.
CREATE TABLE articles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  title      TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 50000),
  -- At most one article per thesis, and the link cannot be moved afterwards:
  -- an article that could be re-pointed at a thesis that happened to resolve
  -- well is a way of claiming a forecast you did not make.
  thesis_id  UUID UNIQUE REFERENCES public_theses(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_articles_creator ON articles (creator_id, created_at DESC);

COMMENT ON TABLE articles IS
  'Creator writing. The prose stays editable -- it is an article, not a record -- but thesis_id '
  'is fixed once set, because the claim it points at is what the article is judged on.';

CREATE OR REPLACE FUNCTION article_thesis_link_is_fixed() RETURNS trigger AS $$
BEGIN
  IF OLD.thesis_id IS NOT NULL AND NEW.thesis_id IS DISTINCT FROM OLD.thesis_id THEN
    RAISE EXCEPTION
      'article % is already bound to thesis %; the binding is what its claim is judged on and '
      'cannot be moved', OLD.id, OLD.thesis_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER articles_thesis_link_fixed
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION article_thesis_link_is_fixed();
