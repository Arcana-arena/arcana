-- 0059_capital_mandates.down.sql
--
-- Drops the mandates and the record of every capital action. The positions
-- themselves are on chain and unaffected; what is lost is ARCANA's account of
-- why each one was taken.
DROP TABLE IF EXISTS capital_actions;
DROP TABLE IF EXISTS capital_mandates;
