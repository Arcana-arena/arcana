-- 0062_capital_reputation_score_check.up.sql
--
-- 0061's score check let a RATED row with NO SCORE through. It read
--
--   (rated AND score BETWEEN 0 AND 100) OR (NOT rated AND score IS NULL)
--
-- and for rated = true, score = NULL the first half is NULL, the second is
-- false, and NULL OR false is NULL — which a CHECK constraint counts as a pass.
-- infra/verify/credit-verify.mjs wrote exactly that row on its first run
-- against production and it was stored. The engine never writes one; the
-- constraint exists for the row that comes from somewhere else.
--
-- Every comparison now has its NULL case stated, so neither half can be NULL.
ALTER TABLE capital_reputation DROP CONSTRAINT capital_reputation_score_ck;
ALTER TABLE capital_reputation ADD CONSTRAINT capital_reputation_score_ck
  CHECK ((rated AND score IS NOT NULL AND score BETWEEN 0 AND 100) OR (NOT rated AND score IS NULL));
