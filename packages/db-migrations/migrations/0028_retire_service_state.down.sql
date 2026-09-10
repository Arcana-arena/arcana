-- 0028_retire_service_state.down.sql
-- Removes the retirement comments and restores 0024's wording on the two
-- tables it had already marked. Purely descriptive: the up migration dropped
-- nothing, altered nothing and moved no data, so reverting it changes no
-- behaviour whatsoever.
--
-- Reverting does NOT un-retire anything. The services are gone from the
-- codebase; a comment cannot bring back a deleted file.
COMMENT ON TABLE service_state IS NULL;

COMMENT ON TABLE deposit_addresses IS
  'RETIRED 2026-09-10. §10 deposit-address payment model. The marketplace is '
  'now P2P with no fee; see docs/on-chain-direction.md.';

COMMENT ON TABLE payment_events IS
  'RETIRED 2026-09-10. §10 deposit-address payment model. The marketplace is '
  'now P2P with no fee; see docs/on-chain-direction.md.';
