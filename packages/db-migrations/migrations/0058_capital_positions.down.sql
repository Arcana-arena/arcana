-- 0058_capital_positions.down.sql
--
-- Drops the capital position history. Nothing acts on it, so nothing breaks,
-- but the record of what an agent owed at each read is gone for good.
DROP TABLE IF EXISTS capital_positions;
