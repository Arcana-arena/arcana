-- 0017_deposit_created_at.up.sql
-- Wall-clock issue time for deposit addresses, so an unpaid one can expire.
--
-- NOTE: not in architecture.md §7 — added alongside 0016 to bound the listener
-- scan floor (§10.2).
--
-- 0016 already records created_at_block, but a TTL is a real-time concept and
-- block height cannot be turned into "24 hours have passed" without assuming a
-- block time — and the Robinhood Chain block time is deliberately not pinned
-- anywhere in this repo. The two columns answer different questions: the block
-- says where to scan from, the timestamp says when to stop waiting.
--
-- Without this, a deposit address that is issued and never paid holds the scan
-- floor at its block forever and the getLogs range grows without bound. That
-- degrades as "the RPC got slow", far from its actual cause.
--
-- DEFAULT now() backfills existing rows with the migration time: they are
-- pre-launch test rows, and dating them to now only delays their first TTL
-- check by one TTL period.

ALTER TABLE deposit_addresses
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The audit sweeps pending rows oldest-first; expired_unpaid rows are read only
-- inside a bounded recent window (late payments to a dead address).
CREATE INDEX idx_deposit_addresses_created_at
  ON deposit_addresses(created_at)
  WHERE status IN ('pending', 'expired_unpaid');
