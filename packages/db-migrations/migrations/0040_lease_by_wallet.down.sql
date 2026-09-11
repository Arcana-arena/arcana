-- Restoring the foreign key requires that no subscription lease is outstanding.
-- Leases expire on their own, so the safe reversal is to clear the table first
-- rather than to fail on a row that would have vanished a minute later.
DELETE FROM agent_execution_leases
 WHERE agent_id NOT IN (SELECT id FROM agents);

ALTER TABLE agent_execution_leases
  ADD CONSTRAINT agent_execution_leases_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id);
