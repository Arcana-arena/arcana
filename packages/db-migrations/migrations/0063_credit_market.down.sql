-- 0063_credit_market.down.sql
--
-- NOT DERIVED, AND NOT RECOVERABLE. An indication exists only in this table:
-- nothing on chain and no other row can rebuild what a provider said. Dropping
-- it loses the record of interest; it moves no money, because none was moved.
DROP TABLE IF EXISTS credit_market_indications;
