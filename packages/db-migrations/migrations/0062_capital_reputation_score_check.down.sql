-- 0062_capital_reputation_score_check.down.sql
-- Restores 0061's check, including the hole it had: a rated row with no score.
ALTER TABLE capital_reputation DROP CONSTRAINT capital_reputation_score_ck;
ALTER TABLE capital_reputation ADD CONSTRAINT capital_reputation_score_ck
  CHECK ((rated AND score BETWEEN 0 AND 100) OR (NOT rated AND score IS NULL));
