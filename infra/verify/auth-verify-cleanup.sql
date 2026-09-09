-- Remove the rows the auth verification suite created.
-- Legacy seed creators and their nine agents are untouched.
BEGIN;

CREATE TEMP TABLE test_agents AS
  SELECT a.id
    FROM agents a
    JOIN creators c ON c.id = a.creator_id
   WHERE c.handle LIKE 'verify_alice_%'
      OR c.handle LIKE 'verify_bob_%';

DELETE FROM agent_dna           WHERE agent_id IN (SELECT id FROM test_agents);
DELETE FROM score_snapshots     WHERE agent_id IN (SELECT id FROM test_agents);
DELETE FROM portfolio_snapshots
 WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id IN (SELECT id FROM test_agents));
DELETE FROM portfolios          WHERE agent_id IN (SELECT id FROM test_agents);
DELETE FROM decisions           WHERE agent_id IN (SELECT id FROM test_agents);
DELETE FROM agents              WHERE id IN (SELECT id FROM test_agents);

DELETE FROM creators
 WHERE handle LIKE 'verify_alice_%' OR handle LIKE 'verify_bob_%';

-- Sessions and nonces minted during verification.
DELETE FROM auth_sessions;
DELETE FROM auth_nonces;

COMMIT;

SELECT handle, origin FROM creators ORDER BY created_at;
SELECT count(*) AS agents FROM agents;
SELECT count(*) AS sessions FROM auth_sessions;
