-- 0018_score_snapshots_nullable_arcana.up.sql
-- Allows arcana_score to be NULL, meaning "not measured" rather than "zero".
--
-- CHANGES architecture.md §7, which declared the column NOT NULL. §7 has been
-- updated to match.
--
-- Why: risk and consistency can only be judged on an agent that actually
-- competed. Below the participation threshold the honest answer is that they
-- were not measured, and those two columns were already nullable — but a
-- composite built on unmeasured inputs is not a score, so arcana has to be
-- able to say the same thing. Writing a neutral 50 instead looks like humility
-- and is not: it is an invented number, and it let an agent with zero
-- decisions sit at rank 1 on the leaderboard ahead of everyone who turned up.
--
-- The leaderboard reads a NULL arcana_score as "unranked" and excludes the
-- agent from every category, while its profile keeps the factors that WERE
-- measurable (performance, longevity, creator, strategy).

ALTER TABLE score_snapshots ALTER COLUMN arcana_score DROP NOT NULL;
