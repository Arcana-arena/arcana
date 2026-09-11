-- 0041_subscriptions_know_their_agent.up.sql
-- The purchase path and the trading path were not connected.
--
-- WHAT WAS WRONG, AND IT MADE THE WHOLE FEATURE UNREACHABLE.
--
-- Migration 0038 gave subscriptions an `agent_id`, because the fan-out finds
-- who to trade for with
--
--     SELECT ... FROM subscriptions WHERE agent_id = $1 AND status = 'active' ...
--
-- and joining through the listing on every tick would be a join per tick for a
-- value that never changes. What it did not do was teach the one place that
-- CREATES a subscription to fill it in. `SubscriptionsService.grant()` in
-- arca-service — the end of the ARCA claim-payment flow, and the only way a real
-- customer ever gets a subscription — wrote `user_wallet`, `listing_id`,
-- `expires_at` and `status`, exactly as it had before subscriptions traded.
--
-- So a paying customer got a row with a NULL agent_id, the fan-out never
-- matched it, and the agent never traded for them. Everything else worked: the
-- wallet would derive, the book would read, the limits would apply. The feature
-- was complete and unreachable, which is the same shape as the marketplace
-- subscription that bought nothing and is the reason this whole line of work
-- exists.
--
-- It was invisible because every test fixture set agent_id directly. A suite
-- that builds its own rows never exercises the code that builds the real ones.
--
-- THE FIX IS IN THE CODE; THIS IS THE BACKFILL. grant() now reads the agent from
-- the listing on create AND on renewal (a renewal is the repair path for a row
-- written before this). This repairs the rows that already exist.
UPDATE subscriptions s
   SET agent_id = l.agent_id
  FROM marketplace_listings l
 WHERE s.listing_id = l.id
   AND s.agent_id IS NULL
   AND l.agent_id IS NOT NULL;

-- WHY NOT A NOT NULL CONSTRAINT. `listing_id` is itself nullable, and a listing
-- may name no agent, so there are legitimate rows this could never satisfy —
-- and a subscription that cannot be traded for is not corrupt, it is just not
-- traded for. What must not happen is a subscription whose listing DOES name an
-- agent silently failing to carry it, and that is checked where it can actually
-- be seen: `infra/verify/subscription-verify.mjs` asserts it of the live table
-- on every run, so a regression in grant() surfaces as a failing check rather
-- than as a customer who paid and was never traded for.
COMMENT ON COLUMN subscriptions.agent_id IS
  'Which agent trades for this subscription. Denormalised from the listing at '
  'purchase time, because the fan-out reads it on every tick. A property of '
  'what was BOUGHT, never of what the buyer later asks for — see '
  'docs/subscription-trading.md.';
