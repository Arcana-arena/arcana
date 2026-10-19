-- 0067_lp_harvest.up.sql
-- FEE HARVESTING — the recurring action that realizes the income.
--
-- Until now the loop could only propose a rebalance or a close, so fees that
-- accrued while a position sat comfortably in range were collected only when
-- the price happened to leave the range. The whole thesis of the pivot is that
-- the fee income is the business; it should be realized on a schedule, not on a
-- price accident.
--
-- The loop now proposes `harvest` when the EXACT accrual (feeGrowthInside, the
-- same number collect() pays) crosses lp_harvest_min_usd. The executor's plan
-- for it is one lp_collect — no approvals, no deadlines, nothing to undo.
--
-- No new columns: the accrual is computed fresh on every sync from chain state,
-- and the proposal carries its numbers in detail. A cached copy in this table
-- would be a second opinion about a number the chain owns.

ALTER TABLE lp_positions DROP CONSTRAINT lp_positions_recommendation_ck;
ALTER TABLE lp_positions ADD CONSTRAINT lp_positions_recommendation_ck
  CHECK (recommendation IS NULL OR recommendation IN ('hold', 'harvest', 'rebalance', 'empty'));

ALTER TABLE lp_position_actions DROP CONSTRAINT lp_position_actions_recommendation_ck;
ALTER TABLE lp_position_actions ADD CONSTRAINT lp_position_actions_recommendation_ck
  CHECK (recommendation IN ('rebalance', 'empty', 'harvest'));
