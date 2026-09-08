-- 0019_decisions_snapshot_fk.up.sql
-- Binds every decision to the market snapshot it was made against.
--
-- §12 calls market_snapshot_ref the immutable evidence behind a decision: it is
-- what makes the decision history *verified* rather than merely recorded. A
-- decision whose snapshot has been deleted cannot be audited — all that remains
-- is a note that an agent did something, with no way to say against what market.
--
-- That is not hypothetical. During the Season 1 reset, market_snapshots was
-- cleared while some decisions were kept, and 26 decisions were left pointing at
-- 7 refs that no longer existed. Two of them were holder_v1's only trades, which
-- silently blinded two of its eight Agent DNA features — the numbers read 0 as
-- though the behaviour were absent rather than unobservable.
--
-- Manual discipline had one job here and lost. Hence a constraint: retention of
-- a snapshot is now the database's business, not an operator's memory.
--
-- ON DELETE RESTRICT: a snapshot cannot be deleted while any decision cites it.
-- To retire old market data, retire the decisions that depend on it first, and
-- record why (see docs/data-resets.md).
--
-- PREREQUISITE: no orphaned rows may exist or this ALTER fails. That failure is
-- intended — it forces whoever runs it to look at the data rather than have a
-- migration quietly delete evidence. The cleanup is an explicit operational
-- step, logged in docs/data-resets.md, never a side effect of a schema change.
--
-- TimescaleDB note: `decisions` is a hypertable (time on ts + 16 hash
-- partitions on agent_id). A foreign key pointing OUT of a hypertable to a
-- plain table is supported and propagates to every chunk; the unsupported
-- direction is a plain table referencing a hypertable, which is not what this
-- is. Verified against TimescaleDB 2.29.2.

ALTER TABLE decisions
  ADD CONSTRAINT decisions_market_snapshot_ref_fkey
  FOREIGN KEY (market_snapshot_ref) REFERENCES market_snapshots(ref)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
