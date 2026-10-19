-- 0065_lp_positions.down.sql
--
-- MIXED RECOVERABILITY, STATED PLAINLY. lp_positions and lp_sync_heartbeat are
-- caches of chain state: dropping them loses nothing the chain cannot rebuild
-- by re-running discovery. lp_position_actions is NOT rebuildable — nothing on
-- chain records what the loop proposed and when — so dropping it loses that
-- history. No row here moved money, so none of this reverses a transfer.
DROP TABLE IF EXISTS lp_position_actions;
DROP TABLE IF EXISTS lp_positions;
DROP TABLE IF EXISTS lp_sync_heartbeat;
