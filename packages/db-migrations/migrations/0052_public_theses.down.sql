-- 0052_public_theses.down.sql
--
-- This drops published predictions and the creator record built from them.
-- There is no backup inside the schema: a thesis is only evidence because it
-- was written before the outcome, and nothing recreated afterwards has that
-- property. Run it on a database you are prepared to lose these from.

DROP TRIGGER IF EXISTS articles_thesis_link_fixed ON articles;
DROP FUNCTION IF EXISTS article_thesis_link_is_fixed();
DROP TABLE IF EXISTS articles;

DROP TRIGGER IF EXISTS public_theses_count ON public_theses;
DROP FUNCTION IF EXISTS public_thesis_counters();
DROP TRIGGER IF EXISTS public_theses_immutable ON public_theses;
DROP FUNCTION IF EXISTS public_thesis_is_published();
DROP TABLE IF EXISTS public_theses;

ALTER TABLE creators
  DROP COLUMN IF EXISTS theses_published,
  DROP COLUMN IF EXISTS theses_proven;
