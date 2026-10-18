-- 0064_arbitrage_opportunities.down.sql
--
-- NOT DERIVED, AND NOT RECOVERABLE. These rows exist only in this database:
-- nothing on chain can rebuild what the scanner measured. Dropping them loses
-- the observation history; it moves no money, because none was moved.
DROP TABLE IF EXISTS arbitrage_opportunities;
DROP TABLE IF EXISTS arbitrage_scan_heartbeat;
