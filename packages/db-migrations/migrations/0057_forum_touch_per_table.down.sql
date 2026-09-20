-- 0057_forum_touch_per_table.down.sql
--
-- Restores 0056's shared trigger function EXACTLY, including the bug: on
-- forum_posts every UPDATE fails with `record "new" has no field "title"`, so
-- hiding or editing a reply or an article comment returns 500.
--
-- It is restored faithfully anyway. A down migration that quietly installs a
-- better version of what it is reverting to leaves the schema in a state no
-- migration describes, and the next person comparing two databases finds a
-- difference neither file explains. If you are running this, run 0057 up again
-- afterwards or expect moderation to be broken.

DROP TRIGGER IF EXISTS forum_threads_touch ON forum_threads;
DROP TRIGGER IF EXISTS forum_posts_touch ON forum_posts;
DROP FUNCTION IF EXISTS forum_thread_touch();
DROP FUNCTION IF EXISTS forum_post_touch();

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
