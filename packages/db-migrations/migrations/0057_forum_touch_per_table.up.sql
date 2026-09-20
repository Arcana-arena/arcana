-- 0057_forum_touch_per_table.up.sql
-- One updated_at trigger per table, because a shared one could not be written.
--
-- WHAT BROKE. 0056 gave forum_threads and forum_posts the same trigger
-- function, which branched on TG_TABLE_NAME:
--
--   IF NEW.body IS DISTINCT FROM OLD.body
--      OR (TG_TABLE_NAME = 'forum_threads' AND NEW.title IS DISTINCT FROM OLD.title)
--
-- That reads as though the left half of the AND guards the right half. It does
-- not. PL/pgSQL resolves a record field when it EVALUATES the expression, and
-- the whole condition is one expression, so `NEW.title` is looked up on every
-- row of both tables. On forum_posts, which has no title, every UPDATE failed:
--
--   ERROR: record "new" has no field "title"
--
-- The visible symptom was worse than the cause. Hiding a reply is an UPDATE, so
-- moderation answered 500 on every post — forum-verify caught it as six failed
-- checks about hidden bodies still being served, which reads like a content
-- leak and was a missing column in a trigger.
--
-- SO THE BRANCH IS GONE RATHER THAN FIXED. Nesting the title test inside an
-- `IF TG_TABLE_NAME = 'forum_threads' THEN` block would also work, because a
-- statement that never executes is never planned — but it would leave the same
-- trap one edit away for whoever next adds a column to one table and not the
-- other. Two functions cannot have the problem at all: each names only fields
-- its own table has, and the database rejects the next mistake of this shape at
-- CREATE FUNCTION time instead of at 3am on an UPDATE.

DROP TRIGGER IF EXISTS forum_threads_touch ON forum_threads;
DROP TRIGGER IF EXISTS forum_posts_touch ON forum_posts;
DROP FUNCTION IF EXISTS forum_touch_updated_at();

-- A thread is edited when its prose or its title moves. Not when a reply
-- arrives, not when somebody likes it: those write reply_count and like_count,
-- and marking the thread "edited" for them would put a word on the page that
-- accuses the author of something they did not do.
CREATE OR REPLACE FUNCTION forum_thread_touch() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A post has no title. That is the whole difference, and it is now expressed
-- by a function that never mentions one.
CREATE OR REPLACE FUNCTION forum_post_touch() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER forum_threads_touch BEFORE UPDATE ON forum_threads
  FOR EACH ROW EXECUTE FUNCTION forum_thread_touch();
CREATE TRIGGER forum_posts_touch BEFORE UPDATE ON forum_posts
  FOR EACH ROW EXECUTE FUNCTION forum_post_touch();
