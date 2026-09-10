-- 0028_retire_service_state.up.sql
-- Completes the §10 retirement that 0024 could only mark provisionally.
--
-- 0024 marked deposit_addresses and payment_events as retired while their
-- SERVICES were still standing, because the replacement had not been proven
-- yet. Phase 11 proved it (22/22, against real USDG transfers on chain), and
-- on 2026-09-11 the code went: HdWalletService, DepositAddressesService,
-- PaymentListenerService and the three entities only they used. This migration
-- records the part 0024 could not:
--
--   1. service_state, which 0024 did not touch at all.
--   2. That the tables now have no reader either, not just no writer.
--
-- service_state was introduced by migration 0015 described as generic
-- key-value state for background services. It never became that. Tracing every
-- reference before removing anything found exactly ONE consumer in the whole
-- codebase — PaymentListenerService, storing its scan cursor — so the general
-- facility was in the description, not in the code. It is retired with the
-- listener rather than kept on the strength of a name.
--
-- Empty, all three, verified on production immediately before this ran:
-- deposit_addresses 0, payment_events 0, service_state 0. Nothing is lost by
-- keeping them and nothing is gained by dropping them, so they stay, marked.
--
-- STILL LIVE, and must not be swept up with the rest:
--   subscriptions   -- the access record. SubscriptionsService.hasAccess() and
--                      the active -> grace -> expired lifecycle read and write
--                      it, ClaimsService.grant() writes it, and
--                      GET /v1/arca/access remains the single source of truth.
--   payment_claims  -- migration 0027; the replacement, now the only way a
--                      marketplace payment is recorded.
--   user_push_tokens -- ReminderService.

COMMENT ON TABLE service_state IS
  'RETIRED 2026-09-11. Introduced by 0015 as generic background-service state; '
  'its only consumer was ever PaymentListenerService (the §10 deposit scan '
  'cursor), which was removed the same day. Empty. Kept, not dropped, so the '
  'schema itself can answer what was here. Do not add new state to this table — '
  'a service that needs durable state should own a table that names it.';

COMMENT ON TABLE deposit_addresses IS
  'RETIRED 2026-09-11 (marked provisionally by 0024). The generating service, '
  'DepositAddressesService, and the HD derivation behind it are gone from the '
  'codebase; this table now has neither writer nor reader. The marketplace is '
  'P2P with no fee: the buyer transfers straight to the creator and submits the '
  'transaction hash, verified against the chain. See payment_claims (0027) and '
  'docs/marketplace-payments.md.';

COMMENT ON TABLE payment_events IS
  'RETIRED 2026-09-11 (marked provisionally by 0024). PaymentListenerService, '
  'which was its only writer, is gone. Its tx_hash UNIQUE constraint was '
  'tidiness here — payments could only arrive at an address ARCANA generated. '
  'In the replacement it is load-bearing: see payment_claims (0027), where a '
  'transaction hash is public the moment it is mined and UNIQUE (tx_hash) is '
  'the entire anti-replay design.';
