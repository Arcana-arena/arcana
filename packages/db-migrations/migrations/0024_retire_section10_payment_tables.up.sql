-- 0024_retire_section10_payment_tables.up.sql
-- Marks the §10 payment tables as retired, WITHOUT dropping them.
--
-- WHY MARK RATHER THAN DROP. The marketplace is now P2P with no fee: the buyer
-- transfers straight to the creator's wallet and submits the transaction hash,
-- which ARCANA verifies against the chain. There is no deposit address, no
-- treasury transit and no split, so the tables that served that model have no
-- future writer (docs/on-chain-direction.md §g).
--
-- All four are empty — verified on production before this migration was
-- written: deposit_addresses 0, payment_events 0, creator_payouts 0,
-- user_push_tokens 0. So nothing is being preserved for its content. What is
-- being preserved is the ability to answer "what was here, and what happened to
-- it" from the database itself, months later, without reading a changelog.
--
-- A comment is the right weight for that. It travels with the schema, shows up
-- in \d+ and in every introspection tool, and cannot go stale in the way a note
-- in a document can, because it sits on the object it describes.
--
-- WHAT IS *NOT* RETIRED, and must not be swept up with the rest:
--
--   subscriptions      -- STILL LIVE. It is the access record. hasAccess() and
--                         the active -> grace -> expired lifecycle both read and
--                         write it, and GET /v1/arca/access is the single source
--                         of truth marketplace consults. Retiring §10 does not
--                         retire subscriptions; they were only ever neighbours.
--   marketplace_listings -- still the catalogue.
--   service_state      -- generic key/value for background services. The payment
--                         listener's block checkpoint was its first user, not its
--                         only possible one.
--
-- THE DEPOSIT PATH IS INTERLOCKED IN CODE, not merely unconfigured.
-- DepositAddressesService.generate() now refuses by decision. It previously
-- refused only because ARCA_MASTER_PRIVATE_KEY and ARCA_RPC_URL were empty —
-- and docs/arca-go-live.md is a written procedure telling somebody to fill
-- exactly those in. A retired path one environment variable away from waking up
-- is not retired.

COMMENT ON TABLE creator_payouts IS
  'RETIRED 2026-09-10. The 80/20 split and treasury payout model is gone: the '
  'marketplace is P2P with no fee, so ARCANA never holds or splits a payment '
  'and has nothing to pay out. PayoutBatchService and its systemd timer were '
  'removed in the same change. Empty at retirement. Kept, not dropped, so the '
  'schema records what existed. See docs/on-chain-direction.md.';

COMMENT ON TABLE deposit_addresses IS
  'RETIRED 2026-09-10, code path interlocked. Replaced by buyer-submitted '
  'transaction-hash verification. DepositAddressesService.generate() refuses by '
  'decision, not by configuration, so filling in ARCA_* cannot revive it. Empty '
  'at retirement. Dropped in phase 11 once the replacement is proven.';

COMMENT ON TABLE payment_events IS
  'RETIRING 2026-09-10. Written only by the payment listener, which watched '
  'deposit addresses. Its tx_hash UNIQUE constraint carries over to the '
  'replacement as the guard against a buyer submitting the same hash twice — '
  'that constraint is now load-bearing rather than tidy. Empty at retirement.';

COMMENT ON TABLE subscriptions IS
  'LIVE. Not part of the §10 retirement. This is the access record: hasAccess() '
  'and the active -> grace -> expired lifecycle read and write it, and '
  'GET /v1/arca/access is the one place the grace rule lives. A second copy of '
  'that rule in another service already drifted once and denied access through '
  'the whole grace period.';
