-- 0024_retire_section10_payment_tables.down.sql
-- Removes the retirement comments. Purely descriptive: nothing was dropped or
-- altered by the up migration, so reverting changes no data and no behaviour.
--
-- Note that reverting this does NOT un-retire anything. The deposit path is
-- interlocked in DepositAddressesService.generate(), and the payout batch no
-- longer exists in the codebase.
COMMENT ON TABLE creator_payouts IS NULL;
COMMENT ON TABLE deposit_addresses IS NULL;
COMMENT ON TABLE payment_events IS NULL;
COMMENT ON TABLE subscriptions IS NULL;
