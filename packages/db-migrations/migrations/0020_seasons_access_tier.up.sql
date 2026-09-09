-- 0020_seasons_access_tier.up.sql
-- Marks a season as a Premium Arena: an arena whose entry is gated on $ARCA.
--
-- WHY seasons AND NOT competitions. A season already *is* the competitive
-- environment (§7: universe, ruleset, window); a competition is one match held
-- inside it. Marking competitions would make the tier a property of the match,
-- which allows an ungated competition to be created inside a premium arena --
-- a hole built into the schema. Marking the season makes "premium" a property
-- of the environment, so every competition in it inherits the gate and none can
-- opt out.
--
-- WHY NO amount COLUMN. The tier says WHICH gate applies; how much $ARCA that
-- gate demands stays in ARCA_GATE_PREMIUM_ARENA on arca-service, alongside
-- every other threshold. A per-season amount would put a second owner on a
-- number the entitlement layer is the authority for, and the check API takes no
-- per-call amount. Per-arena thresholds remain possible later -- see
-- docs/premium-arena.md -- but they are an API change, not a column.
--
-- DEFAULT 'standard' NOT NULL: every existing season, Season 1 included, stays
-- exactly what it was. Premium is opt-in per arena, never a migration outcome.

ALTER TABLE seasons
  ADD COLUMN access_tier VARCHAR(20) NOT NULL DEFAULT 'standard';

ALTER TABLE seasons
  ADD CONSTRAINT seasons_access_tier_check
  CHECK (access_tier IN ('standard', 'premium'));
