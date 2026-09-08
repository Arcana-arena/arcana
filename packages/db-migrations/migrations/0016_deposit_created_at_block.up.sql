-- 0016_deposit_created_at_block.up.sql
-- Records the chain height at which a deposit address was handed to the user.
--
-- NOTE: not in architecture.md §7 — added to close the payment-loss hole found
-- in E2E verification (see §10.6 "Listener checkpoint ahead of a payment").
--
-- Without it the listener's first checkpoint is computed as `head - N` at its
-- first successful poll, which can land AFTER a transfer the user already made
-- against an address issued moments earlier. That transfer is then never
-- scanned: funds arrive, access is never granted, and nothing logs a warning.
--
-- With it the listener clamps its scan start to the oldest still-pending
-- deposit, so no address can ever be issued above the scan floor. It also lets
-- the audit pass tell a genuinely stale deposit apart from one that simply has
-- not reached the confirmation depth yet.
--
-- Nullable on purpose: rows created before this migration have no known height
-- and are skipped by the clamp (COALESCE) rather than forcing a genesis rescan.

ALTER TABLE deposit_addresses ADD COLUMN created_at_block BIGINT;

-- Partial index: the listener queries the minimum height across pending rows on
-- every poll, and that is the only access pattern for this column.
CREATE INDEX idx_deposit_addresses_pending_block
  ON deposit_addresses(created_at_block)
  WHERE status = 'pending';
