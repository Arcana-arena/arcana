-- 0067_lp_harvest.down.sql
--
-- Reverses exactly the two CHECK constraints. It refuses while any row carries
-- 'harvest' — which is the honest failure: the rows would have to be relabelled,
-- and a recommendation history is not something a rollback should rewrite.
ALTER TABLE lp_positions DROP CONSTRAINT lp_positions_recommendation_ck;
ALTER TABLE lp_positions ADD CONSTRAINT lp_positions_recommendation_ck
  CHECK (recommendation IS NULL OR recommendation IN ('hold', 'rebalance', 'empty'));

ALTER TABLE lp_position_actions DROP CONSTRAINT lp_position_actions_recommendation_ck;
ALTER TABLE lp_position_actions ADD CONSTRAINT lp_position_actions_recommendation_ck
  CHECK (recommendation IN ('rebalance', 'empty'));
