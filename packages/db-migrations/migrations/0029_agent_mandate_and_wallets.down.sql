-- 0029_agent_mandate_and_wallets.down.sql
--
-- WARNING, and it is a real one rather than boilerplate. Dropping agent_wallets
-- destroys the record of WHICH ADDRESS BELONGS TO WHICH AGENT, and for derived
-- wallets the derivation_index needed to re-derive the key after a restore.
-- The keys themselves survive in the signer's keystore, but nothing would be
-- left to say which agent each one is for. Take a backup first; this is the
-- one table in this migration whose loss is not recoverable from elsewhere.
--
-- custody_drift is an audit trail of somebody's money moving. Dropping it is
-- destroying evidence, not tidying up.
DROP TABLE IF EXISTS custody_drift;
DROP TABLE IF EXISTS agent_wallets;

ALTER TABLE agents
  DROP COLUMN IF EXISTS mandate_params,
  DROP COLUMN IF EXISTS mandate_template;
