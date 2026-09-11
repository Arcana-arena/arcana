-- IRREVERSIBLE BY CHOICE, and the comment is the honest part.
--
-- The up migration filled in a value that was missing. Clearing it again would
-- not restore a previous state — it would recreate the defect, and on rows that
-- may since have been written correctly by grant(). There is no way to tell a
-- backfilled agent_id from one written at purchase time, and there should not
-- be: they mean the same thing.
--
-- So the reversal is the comment, not the data.
COMMENT ON COLUMN subscriptions.agent_id IS
  'Denormalised from the listing so the fan-out can find subscribers by agent '
  'without joining two tables on every tick. Written once at subscribe time.';
