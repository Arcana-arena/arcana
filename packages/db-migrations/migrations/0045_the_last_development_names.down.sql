-- 0045_the_last_development_names.down.sql
--
-- Exact inverse. Restores the names 0044 left, not the ones before it.

BEGIN;

UPDATE agents SET name = 'first_swap_v1'  WHERE name = 'onchain_pilot_a';
UPDATE agents SET name = 'chain_cycle_v1' WHERE name = 'onchain_pilot_b';
UPDATE seasons SET name = 'Season 0 - bring-up' WHERE name = 'Season 0 - US Equities';

COMMIT;
