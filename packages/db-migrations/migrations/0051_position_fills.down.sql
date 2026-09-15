DROP VIEW IF EXISTS position_episodes;
DROP TRIGGER IF EXISTS position_fills_append_only ON position_fills;
DROP FUNCTION IF EXISTS position_fill_is_append_only();
DROP TABLE IF EXISTS position_fills;
