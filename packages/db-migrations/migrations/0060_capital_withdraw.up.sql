-- 0060_capital_withdraw.up.sql
-- A capital action may be a WITHDRAW: collateral taken back from the market to
-- the agent's own wallet, by the owner's hand. The mandate's decider never
-- proposes one; the engine refuses one that would leave debt under the floor.
ALTER TABLE capital_actions DROP CONSTRAINT capital_actions_kind_ck;
ALTER TABLE capital_actions ADD CONSTRAINT capital_actions_kind_ck
  CHECK (kind IN ('hold', 'supply', 'borrow', 'repay', 'withdraw', 'deleverage'));
