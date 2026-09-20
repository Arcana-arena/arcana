-- 0056_forum_and_social_articles.down.sql
--
-- This drops every thread, reply, comment, like, save and report. None of it is
-- recoverable from elsewhere in the schema -- unlike a thesis, a conversation
-- has no second copy anywhere.
--
-- articles SURVIVES. Only the columns 0056 added to it are removed, which
-- unbinds any article from the agent it named. That loss is why the column is
-- called out here: re-running the up migration afterwards does not restore the
-- bindings, and the trigger will happily accept new ones as though they were
-- the first.

DROP TRIGGER IF EXISTS forum_posts_touch ON forum_posts;
DROP TRIGGER IF EXISTS forum_threads_touch ON forum_threads;
DROP FUNCTION IF EXISTS forum_touch_updated_at();

DROP TRIGGER IF EXISTS content_reactions_rollup ON content_reactions;
DROP FUNCTION IF EXISTS forum_rollup_reactions();

DROP TRIGGER IF EXISTS forum_posts_rollup ON forum_posts;
DROP FUNCTION IF EXISTS forum_rollup_posts();

DROP TABLE IF EXISTS content_reports;
DROP TABLE IF EXISTS content_reactions;
DROP TABLE IF EXISTS forum_posts;
DROP TABLE IF EXISTS forum_threads;
DROP TABLE IF EXISTS forum_boards;

-- The article trigger goes back to exactly what 0052 installed. Leaving the
-- 0056 body in place would keep a function referencing articles.agent_id after
-- the column is gone, and the next UPDATE on any article would fail with a
-- missing-field error that names neither migration.
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

DROP INDEX IF EXISTS idx_articles_recent;
DROP INDEX IF EXISTS idx_articles_agent;

ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_hidden_together;

ALTER TABLE articles
  DROP COLUMN IF EXISTS hidden_reason,
  DROP COLUMN IF EXISTS hidden_by,
  DROP COLUMN IF EXISTS hidden_at,
  DROP COLUMN IF EXISTS comment_count,
  DROP COLUMN IF EXISTS save_count,
  DROP COLUMN IF EXISTS like_count,
  DROP COLUMN IF EXISTS agent_id;
