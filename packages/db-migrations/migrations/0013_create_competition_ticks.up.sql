-- 0013_create_competition_ticks.up.sql
-- ARCANA competition_ticks table (turn management for human_vs_ai sessions).
--
-- NOTE: outside architecture.md §7 (adds the missing "session/turn" concept for
-- competitions). Each tick is one decision round:
--   - scheduler opens a tick (phase='open'), runs AI agents, waits a window for
--     human submissions, then closes it (phase='closed').
--   - market_snapshot_ref is the SAME immutable snapshot all participants act on.
--   - UNIQUE(competition_id, tick_index) prevents double-opening a round.

CREATE TABLE competition_ticks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  tick_index INT NOT NULL,
  phase VARCHAR(20) NOT NULL DEFAULT 'open',   -- open, closed
  market_snapshot_ref VARCHAR(120) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_end TIMESTAMPTZ,                       -- set when phase -> closed
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(competition_id, tick_index)
);
CREATE INDEX idx_competition_ticks_comp ON competition_ticks(competition_id, tick_index DESC);
