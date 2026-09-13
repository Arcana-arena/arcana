-- 0044_names_from_the_development_era.down.sql
--
-- Puts the development-era labels back. It is exact: every statement is the
-- inverse of one in the up migration, and the same uuid rows are touched.
--
-- The one that cannot be inverted blindly is `momentum_bot`. Restoring it by
-- name alone would rename BOTH agents to the same string again, which is the
-- duplicate that made the leaderboard's row order non-deterministic. It is
-- scoped by strategy_type for the same reason the up migration was.

BEGIN;

UPDATE creators SET handle = 'dummy_creator'
 WHERE handle = 'arcana_labs';

UPDATE agents SET name = 'Phase 8 first swap'   WHERE name = 'first_swap_v1';
UPDATE agents SET name = 'Phase 8b chain cycle' WHERE name = 'chain_cycle_v1';
UPDATE agents SET name = 'dummy_agent_v2'       WHERE name = 'trend_follow_v1';
UPDATE agents SET name = 'gate_probe'           WHERE name = 'hold_probe_v1';

UPDATE agents SET name = 'momentum_bot'
 WHERE name = 'reversion_bot' AND strategy_type = 'mean_reversion';

UPDATE seasons SET name = 'Dummy Season 1'
 WHERE name = 'Season 0 - bring-up';

COMMIT;
