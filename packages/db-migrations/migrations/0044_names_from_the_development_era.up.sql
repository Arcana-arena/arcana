-- 0044_names_from_the_development_era.up.sql
--
-- THE RECORDS ARE REAL. THE NAMES WERE PLACEHOLDERS.
--
-- The public surface sells one thing: a track record nobody can edit after the
-- price moved. It was showing that record under `dummy_creator`, `Phase 8b
-- chain cycle` and `Dummy Season 1` — names typed during bring-up and never
-- revisited. The history behind them is genuine: 1,040 decisions in Season 1,
-- 161 in Season 2, real fills on chain 4663. It is only the labels that came
-- from a development afternoon, and a page that reads as a demo undermines the
-- exact claim it exists to make.
--
-- NOTHING IS DELETED AND NOTHING MOVES. Every foreign key into creators and
-- agents is by uuid — agents_creator_id_fkey and creator_payouts_creator_id_fkey
-- are the only two, and both reference creators(id) — so a handle is a label and
-- not a key. Renaming one changes what is printed and nothing else. The
-- decisions, executions, scores and snapshots keep pointing at the same rows.
--
-- TWO AGENTS WERE BOTH CALLED `momentum_bot`, and one of them is a
-- mean_reversion agent. That is worse than untidy:
--
--   * The name contradicts the strategy the engine actually runs, and the
--     contradiction was visible in the leaderboard's main table — a reader
--     comparing "momentum_bot" against momentum_v1 was comparing two different
--     strategies that looked like the same one.
--   * A duplicate name made the leaderboard's row order non-deterministic. That
--     is the defect commit 'the row order was not a total order' had to fix with
--     agent_id as a final tiebreak, and this pair is what exposed it.
--
-- The strategy is left alone — it drives behaviour and scoring, and changing it
-- would alter what the agent does. The NAME is what was wrong.

BEGIN;

-- The creator that owns the first nine agents.
UPDATE creators SET handle = 'arcana_labs'
 WHERE handle = 'dummy_creator';

-- Agents, renamed to describe what they are rather than which phase built them.
UPDATE agents SET name = 'first_swap_v1'   WHERE name = 'Phase 8 first swap';
UPDATE agents SET name = 'chain_cycle_v1'  WHERE name = 'Phase 8b chain cycle';
UPDATE agents SET name = 'trend_follow_v1' WHERE name = 'dummy_agent_v2';
UPDATE agents SET name = 'hold_probe_v1'   WHERE name = 'gate_probe';

-- The mean_reversion agent misnamed after the opposite strategy. Scoped by
-- strategy_type so the correctly-named momentum agent keeps its name.
UPDATE agents SET name = 'reversion_bot'
 WHERE name = 'momentum_bot' AND strategy_type = 'mean_reversion';

-- A season that holds nothing: no decision, no competition, no participant. It
-- is renamed rather than removed, because an empty season is still a row other
-- rows may one day reference, and deleting history is the one thing this
-- migration refuses to do.
UPDATE seasons SET name = 'Season 0 - bring-up'
 WHERE name = 'Dummy Season 1';

COMMIT;
