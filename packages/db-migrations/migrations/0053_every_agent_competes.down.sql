-- 0053_every_agent_competes.down.sql
--
-- Drops the entry record. The SEATS the up-migration granted are deliberately
-- left in place: they are ordinary participation, agents have been deciding and
-- trading from them since, and removing an agent from a competition it has a
-- record in would orphan those decisions rather than undo anything. Reverting
-- the code without reverting the seats leaves the platform exactly as it was
-- before this change — a competition with more participants in it, entered by
-- hand as far as anything can tell.
--
-- What is lost is the knowledge of WHEN each agent entered, which is only
-- recoverable from the first decision each one recorded.

DROP TABLE IF EXISTS competition_entries;
