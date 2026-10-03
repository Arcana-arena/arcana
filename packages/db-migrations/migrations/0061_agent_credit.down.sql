-- 0061_agent_credit.down.sql
--
-- Cycles, reputation rows and the scan cursor are derived and are rebuilt by
-- the guard. capital_liquidations is read from Morpho's events and is read
-- again from the allowlist's liquidations_from_block once the cursor is gone.
DROP TABLE IF EXISTS capital_reputation;
DROP TABLE IF EXISTS capital_cycles;
DROP TABLE IF EXISTS capital_scan_cursors;
DROP TABLE IF EXISTS capital_liquidations;
