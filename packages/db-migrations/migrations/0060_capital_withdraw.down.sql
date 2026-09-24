-- 0060_capital_withdraw.down.sql
--
-- Refuses to run over recorded withdrawals rather than deleting them: the
-- record of what the owner took back is not something a schema rollback may
-- erase. Delete those rows deliberately first if the rollback is really meant.
ALTER TABLE capital_actions DROP CONSTRAINT capital_actions_kind_ck;
ALTER TABLE capital_actions ADD CONSTRAINT capital_actions_kind_ck
  CHECK (kind IN ('hold', 'supply', 'borrow', 'repay', 'deleverage'));
