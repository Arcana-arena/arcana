-- 0045_the_last_development_names.up.sql
--
-- The three labels 0044 left half-done.
--
-- 0044 replaced `Phase 8 first swap` and `Phase 8b chain cycle` with
-- `first_swap_v1` and `chain_cycle_v1`, and `Dummy Season 1` with
-- `Season 0 - bring-up`. Those are better and still wrong in the same way: they
-- describe the phase of development that produced the row rather than the thing
-- the row is. A visitor reading a public track record should not be able to
-- tell which sprint an agent came from.
--
-- WHY RENAME AND NOT HIDE. Two alternatives were considered and both are worse:
--
--   * A rule that hides empty seasons would also hide Premium Arena - Q4
--     Invitational, which has no agents because it has not opened yet. Empty
--     because nothing happened and empty because nothing has happened YET are
--     different facts, and one rule cannot tell them apart.
--   * A provenance column on seasons would mark genuine history as not genuine.
--     `provenance` means "created by a verification run", and none of these
--     were. Their decisions, fills and scores are real.
--
-- Renaming is the same answer phase8_operator -> onchain_operator already took.
-- Honest, and it deletes nothing.
--
-- THE TWO AGENTS ARE THE FIRST LIVE ON-CHAIN RUNS, owned by onchain_operator,
-- both retired, 4 and 8 recorded decisions. `pilot_a` and `pilot_b` describe
-- that without implying one evolved from the other — they have no lineage
-- between them, and a `_v1`/`_v2` pair would assert one.

BEGIN;

UPDATE agents SET name = 'onchain_pilot_a' WHERE name = 'first_swap_v1';
UPDATE agents SET name = 'onchain_pilot_b' WHERE name = 'chain_cycle_v1';

-- Named like the seasons either side of it. That it holds nothing is already
-- visible in its own counters — 0 agents, 0 competitions — and does not need
-- to be in its name.
UPDATE seasons SET name = 'Season 0 - US Equities' WHERE name = 'Season 0 - bring-up';

COMMIT;
