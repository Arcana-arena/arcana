-- 0056_forum_and_social_articles.up.sql
-- The social layer: a forum, comments, like/save, and reports.
--
-- WHAT THIS IS NOT. Nothing in this migration is read by the decision engine,
-- the scoring engine, or anything that writes to score_snapshots. There is no
-- column here that an agent can see and no join from any table here into
-- decisions, mandates or prompts. That is the one property the whole feature
-- rests on: a platform where the loudest thread moved an agent's score would be
-- a popularity contest wearing a track record's clothes.
--
-- It is stated here because a schema is where the claim can be checked without
-- reading any code: grep this file for `decisions`, `score`, `regime` or
-- `mandate` and there is nothing to find. infra/verify/forum-verify.mjs proves
-- the same negative by execution -- it posts a thread about an agent, then asks
-- that agent for a decision and compares it against a twin with no thread.
--
-- WHY EVERY AUTHOR IS A CREATOR AND NOT A WALLET. articles, public_theses and
-- agents all hang off creators(id); a forum keyed on wallet_address would be a
-- second identity space, where the same person has a handle in one half of the
-- site and an 0x-prefix in the other, and where moderating one says nothing
-- about the other. Signing in is not enough to post; having a profile is, and
-- making one is a single form that already exists.
--
-- WHY ON DELETE CASCADE ON creator_id, when 0052 chose RESTRICT for a thesis.
-- A published thesis is EVIDENCE: it outlives its author's account on purpose,
-- and a delete that took it with it would let someone retract a failed forecast
-- by closing their profile. A forum post is CONVERSATION. It carries no claim
-- that anything is measured against, so the reason for RESTRICT does not apply
-- -- and RESTRICT here would have a cost 0052 does not pay: the verification
-- sweep (infra/verify/lib/fixtures.mjs) deletes marked creators in one
-- transaction, and a fixture thread nobody thought about would fail that delete
-- and take every suite's cleanup down with it. There is no product path that
-- deletes a creator; in practice this cascade only ever fires on fixtures.

-- --------------------------------------------------------------------------
-- 1. Boards.
-- --------------------------------------------------------------------------
-- A table rather than a CHECK constraint on a `board` column, because boards
-- get renamed, reordered and described, and none of those should be a
-- migration. The slug is what URLs and the verification suite use, so it is the
-- stable half and the name is the editable one.
CREATE TABLE forum_boards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(40) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 60),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 400),
  position    INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE forum_boards IS
  'Discussion boards. Content only -- no board grants any power over an agent, a score or a '
  'competition, and nothing outside the social endpoints reads this table.';

INSERT INTO forum_boards (slug, name, description, position) VALUES
  ('general', 'General Discussion',
   'Anything about ARCANA, the agents on it, or trading in general.', 1),
  ('strategy', 'Strategy Talk',
   'Mandates, risk profiles, cadence and rebalancing -- what worked and what did not.', 2),
  ('agent-reviews', 'Agent Reviews',
   'Read an agent''s public record and say what you make of it. Opinions here change no score.', 3),
  ('market', 'Market Talk',
   'What the market is doing, and what it means for the agents trading through it.', 4);

-- --------------------------------------------------------------------------
-- 2. Threads.
-- --------------------------------------------------------------------------
CREATE TABLE forum_threads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   UUID NOT NULL REFERENCES forum_boards(id) ON DELETE RESTRICT,
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 50000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- MAINTAINED BY TRIGGER, RECOMPUTED FROM THE POSTS THEMSELVES. A counter the
  -- service increments is a counter that drifts the first time a write path
  -- forgets it, and a list ordered by a drifted timestamp is wrong in the one
  -- place people look first. See forum_thread_rollup() below.
  reply_count   INTEGER NOT NULL DEFAULT 0,
  last_reply_at TIMESTAMPTZ,
  like_count    INTEGER NOT NULL DEFAULT 0,
  save_count    INTEGER NOT NULL DEFAULT 0,

  -- Moderation. The row is KEPT and marked, never deleted: a conversation with
  -- a reply silently removed from the middle reads as though the replies that
  -- followed it were answering something else.
  hidden_at     TIMESTAMPTZ,
  hidden_by     UUID REFERENCES creators(id) ON DELETE SET NULL,
  hidden_reason TEXT CHECK (hidden_reason IS NULL OR length(btrim(hidden_reason)) BETWEEN 3 AND 300),
  CONSTRAINT forum_threads_hidden_together
    CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL))
);

CREATE INDEX idx_forum_threads_board ON forum_threads (board_id, coalesce(last_reply_at, created_at) DESC);
CREATE INDEX idx_forum_threads_creator ON forum_threads (creator_id, created_at DESC);

COMMENT ON COLUMN forum_threads.reply_count IS
  'Every reply, including hidden ones, because a hidden reply still renders -- as a placeholder '
  'saying it was removed. A count that excluded them would disagree with the page it labels.';

-- --------------------------------------------------------------------------
-- 3. Replies, and article comments, in one table.
-- --------------------------------------------------------------------------
-- ONE COMMENT SYSTEM, NOT TWO. A reply under a thread and a comment under an
-- article are the same act: a person writing prose under something somebody
-- else wrote. Two tables would mean two moderation paths, two report shapes and
-- two places to fix the next thing either gets wrong -- and the second one
-- always lags.
--
-- TWO NULLABLE FOREIGN KEYS WITH AN XOR, not one `subject_type`/`subject_id`
-- pair. A polymorphic id cannot be a foreign key, so nothing would stop a post
-- pointing at an article that does not exist, and the database could not
-- cascade. Here both directions are real references and the CHECK makes exactly
-- one of them present.
CREATE TABLE forum_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  UUID REFERENCES forum_threads(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  hidden_at     TIMESTAMPTZ,
  hidden_by     UUID REFERENCES creators(id) ON DELETE SET NULL,
  hidden_reason TEXT CHECK (hidden_reason IS NULL OR length(btrim(hidden_reason)) BETWEEN 3 AND 300),

  CONSTRAINT forum_posts_one_subject CHECK (num_nonnulls(thread_id, article_id) = 1),
  CONSTRAINT forum_posts_hidden_together
    CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL))
);

-- Both partial, because a post is only ever on one side and a full index would
-- be half NULLs either way. The sort key is created_at: the order a
-- conversation happened in is the only order it can be read in.
CREATE INDEX idx_forum_posts_thread  ON forum_posts (thread_id, created_at)  WHERE thread_id IS NOT NULL;
CREATE INDEX idx_forum_posts_article ON forum_posts (article_id, created_at) WHERE article_id IS NOT NULL;
CREATE INDEX idx_forum_posts_creator ON forum_posts (creator_id, created_at DESC);

COMMENT ON TABLE forum_posts IS
  'Replies under a thread and comments under an article -- the same act, one table, one '
  'moderation path. Exactly one of thread_id/article_id is set.';

-- --------------------------------------------------------------------------
-- 4. Like and save.
-- --------------------------------------------------------------------------
-- ONE TABLE FOR BOTH, distinguished by `kind`. They are the same relation --
-- this person, that thing, at this time -- and splitting them would duplicate
-- the XOR, the uniqueness rules and the counter trigger for no gain.
--
-- A LIKE IS NOT A VOTE ON AN AGENT. It counts on the thread or the article and
-- goes no further; there is no path from this table to leaderboard, score or
-- reputation, and forum-verify asserts the count does not move when the score
-- does not.
CREATE TABLE content_reactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  kind       VARCHAR(8) NOT NULL CHECK (kind IN ('like', 'save')),
  thread_id  UUID REFERENCES forum_threads(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_reactions_one_subject CHECK (num_nonnulls(thread_id, article_id) = 1)
);

-- IDEMPOTENCE IS THE DATABASE'S JOB. Liking twice from two tabs must be one
-- like, and a service-side "check then insert" has a race between the two
-- statements that shows up as a count of 2 for one person.
CREATE UNIQUE INDEX uq_content_reactions_thread
  ON content_reactions (creator_id, kind, thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_reactions_article
  ON content_reactions (creator_id, kind, article_id) WHERE article_id IS NOT NULL;
CREATE INDEX idx_content_reactions_saved
  ON content_reactions (creator_id, created_at DESC) WHERE kind = 'save';

-- --------------------------------------------------------------------------
-- 5. Reports.
-- --------------------------------------------------------------------------
-- The foundation, not a moderation system: somebody says this is wrong, it is
-- recorded once per person per item, and a human decides. No auto-hide -- a
-- threshold that hides content on N reports is a brigading tool, and the people
-- most worth reading are the easiest to organise against.
CREATE TABLE content_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  thread_id   UUID REFERENCES forum_threads(id) ON DELETE CASCADE,
  post_id     UUID REFERENCES forum_posts(id) ON DELETE CASCADE,
  article_id  UUID REFERENCES articles(id) ON DELETE CASCADE,
  reason      VARCHAR(20) NOT NULL
                CHECK (reason IN ('spam', 'hate', 'harassment', 'scam', 'off_topic', 'other')),
  detail      TEXT CHECK (detail IS NULL OR length(btrim(detail)) BETWEEN 1 AND 1000),
  status      VARCHAR(12) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES creators(id) ON DELETE SET NULL,
  CONSTRAINT content_reports_one_subject CHECK (num_nonnulls(thread_id, post_id, article_id) = 1),
  CONSTRAINT content_reports_reviewed_together
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);

-- One report per person per item. Reporting the same post from three devices is
-- one objection, and a queue sorted by report count must not be gameable by a
-- single person with a refresh key.
CREATE UNIQUE INDEX uq_content_reports_thread
  ON content_reports (reporter_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_reports_post
  ON content_reports (reporter_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_reports_article
  ON content_reports (reporter_id, article_id) WHERE article_id IS NOT NULL;
CREATE INDEX idx_content_reports_open ON content_reports (created_at DESC) WHERE status = 'open';

-- --------------------------------------------------------------------------
-- 6. Articles join the social layer.
-- --------------------------------------------------------------------------
-- An article may now name an agent DIRECTLY, without a thesis. Writing about
-- one of your agents is not a forecast and must not be forced to pose as one:
-- 0052 deliberately made thesis_id optional for that reason, and requiring a
-- thesis to show the agent card would have undone it.
--
-- THE CARD READS THE AGENT'S OWN ENDPOINTS. This column stores an id and
-- nothing else -- no score, no return, no drawdown copy. A snapshot here would
-- be a second source of truth that agrees with the agent's page only until the
-- next tick.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS like_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS save_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0,
  -- The same three moderation columns forum_threads and forum_posts carry, and
  -- named identically so one service method can hide any of the three. An
  -- article that cannot be hidden would be the one piece of writing on the
  -- platform with no answer to a report.
  ADD COLUMN IF NOT EXISTS hidden_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_by     UUID REFERENCES creators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason TEXT;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_hidden_together;
ALTER TABLE articles
  ADD CONSTRAINT articles_hidden_together
    CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL));

CREATE INDEX IF NOT EXISTS idx_articles_agent ON articles (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_articles_recent ON articles (created_at DESC);

COMMENT ON COLUMN articles.agent_id IS
  'Optional. The agent this article is about, and the one its Linked Agent card reads live. '
  'RESTRICT, not CASCADE: an article outlives the agent it discusses, and a delete that '
  'silently took the writing with it would lose the more durable of the two.';

-- WHY RESTRICT NEEDS THE SWEEP TO KNOW. infra/verify/lib/fixtures.mjs deletes
-- marked agents in one transaction; an article bound to one would fail that
-- delete and take every suite's cleanup with it. The sweep therefore removes
-- fixture-bound articles first -- the same obligation 0052 created for
-- thesis-verify's own purge, written down here because this is where the
-- reference was added.

-- The binding is FIXED ONCE SET, like thesis_id and for a related reason. The
-- card publishes score, return and drawdown; re-pointing an old article at an
-- agent that later did well is claiming a track record the article never
-- discussed. Unset stays unsettable-away: NULL -> agent is allowed once, agent
-- -> anything is not.
--
-- The function from 0052 is REPLACED rather than joined by a second trigger, so
-- one function owns everything about an article that cannot move. Two triggers
-- on the same table would fire in name order and each would have to know what
-- the other already rejected.
CREATE OR REPLACE FUNCTION article_thesis_link_is_fixed() RETURNS trigger AS $$
BEGIN
  IF OLD.thesis_id IS NOT NULL AND NEW.thesis_id IS DISTINCT FROM OLD.thesis_id THEN
    RAISE EXCEPTION
      'article % is already bound to thesis %; the binding is what its claim is judged on and '
      'cannot be moved', OLD.id, OLD.thesis_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION
      'article % already names agent %; its Linked Agent card publishes that agent''s score and '
      'returns, so the binding cannot be moved to another', OLD.id, OLD.agent_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The counters below are written by the rollup triggers, which must not be
  -- read as an edit: touching updated_at for a like would make every article
  -- say "edited" the moment somebody liked it.
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- 7. Counters, recomputed rather than incremented.
-- --------------------------------------------------------------------------
-- EVERY COUNTER HERE IS A COUNT(*) OVER THE ROWS IT COUNTS, re-run on each
-- change. An increment/decrement pair is faster and is wrong the first time a
-- path forgets one half -- and the symptom is a thread listing "3 replies" over
-- two replies, which nobody reports as a bug and everybody stops trusting.
-- These tables are small and the write rate is human-speed; correctness is the
-- cheaper thing to buy here.
CREATE OR REPLACE FUNCTION forum_rollup_posts() RETURNS trigger AS $$
DECLARE
  t UUID := coalesce(NEW.thread_id, OLD.thread_id);
  a UUID := coalesce(NEW.article_id, OLD.article_id);
BEGIN
  IF t IS NOT NULL THEN
    UPDATE forum_threads SET
      reply_count   = (SELECT count(*) FROM forum_posts p WHERE p.thread_id = t),
      last_reply_at = (SELECT max(p.created_at) FROM forum_posts p WHERE p.thread_id = t)
     WHERE id = t;
  END IF;
  IF a IS NOT NULL THEN
    UPDATE articles SET
      comment_count = (SELECT count(*) FROM forum_posts p WHERE p.article_id = a)
     WHERE id = a;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER forum_posts_rollup
  AFTER INSERT OR UPDATE OR DELETE ON forum_posts
  FOR EACH ROW EXECUTE FUNCTION forum_rollup_posts();

CREATE OR REPLACE FUNCTION forum_rollup_reactions() RETURNS trigger AS $$
DECLARE
  t UUID := coalesce(NEW.thread_id, OLD.thread_id);
  a UUID := coalesce(NEW.article_id, OLD.article_id);
BEGIN
  IF t IS NOT NULL THEN
    UPDATE forum_threads SET
      like_count = (SELECT count(*) FROM content_reactions r
                     WHERE r.thread_id = t AND r.kind = 'like'),
      save_count = (SELECT count(*) FROM content_reactions r
                     WHERE r.thread_id = t AND r.kind = 'save')
     WHERE id = t;
  END IF;
  IF a IS NOT NULL THEN
    UPDATE articles SET
      like_count = (SELECT count(*) FROM content_reactions r
                     WHERE r.article_id = a AND r.kind = 'like'),
      save_count = (SELECT count(*) FROM content_reactions r
                     WHERE r.article_id = a AND r.kind = 'save')
     WHERE id = a;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_reactions_rollup
  AFTER INSERT OR UPDATE OR DELETE ON content_reactions
  FOR EACH ROW EXECUTE FUNCTION forum_rollup_reactions();

-- updated_at on the two writable social tables. Editing prose is allowed --
-- these are posts, not records -- and the page says when it happened.
CREATE OR REPLACE FUNCTION forum_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR (TG_TABLE_NAME = 'forum_threads' AND NEW.title IS DISTINCT FROM OLD.title) THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER forum_threads_touch BEFORE UPDATE ON forum_threads
  FOR EACH ROW EXECUTE FUNCTION forum_touch_updated_at();
CREATE TRIGGER forum_posts_touch BEFORE UPDATE ON forum_posts
  FOR EACH ROW EXECUTE FUNCTION forum_touch_updated_at();

-- --------------------------------------------------------------------------
-- 8. The boundary, stated as a constraint the database can hold.
-- --------------------------------------------------------------------------
-- A thread names no agent and no season. It cannot: there is no column for one.
-- If a later migration adds `forum_threads.agent_id` for a "discuss this agent"
-- link, it must be a DISPLAY link only -- read by the web, never by the
-- decision engine -- and forum-verify's decision-equality check is what would
-- catch it becoming anything more.
COMMENT ON TABLE forum_threads IS
  'Forum threads. Deliberately holds no agent, season or competition reference: the social '
  'layer reads the platform, and the platform does not read it back.';
