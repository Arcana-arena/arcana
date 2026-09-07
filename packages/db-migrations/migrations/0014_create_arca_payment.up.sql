-- 0014_create_arca_payment.up.sql
-- $ARCA Subscription & Payment tables, EXACTLY per architecture.md §7 (lines
-- 294-334) + the user_push_tokens registry mentioned in §10.4.
--
-- These tables back the permissioned-chain payment flow of §10: unique HD
-- deposit addresses per subscription, an off-chain payment listener, batch
-- creator payouts, manual-renew subscriptions and in-app push reminders.

CREATE TABLE deposit_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet VARCHAR(64) NOT NULL,
  listing_id UUID REFERENCES marketplace_listings(id),
  derived_address VARCHAR(64) UNIQUE NOT NULL,
  derivation_path VARCHAR(100) NOT NULL,
  expected_amount NUMERIC(20,8) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' -- pending, received, swept, expired_unpaid
);

CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash VARCHAR(80) UNIQUE NOT NULL,
  deposit_address_id UUID REFERENCES deposit_addresses(id),
  amount NUMERIC(20,8) NOT NULL,
  creator_share NUMERIC(20,8),
  platform_share NUMERIC(20,8),
  payout_status VARCHAR(20) DEFAULT 'pending' -- pending, paid, disputed
);

CREATE TABLE creator_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  total_amount NUMERIC(20,8),
  tx_hash VARCHAR(80),
  status VARCHAR(20) DEFAULT 'pending'
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet VARCHAR(64) NOT NULL,
  listing_id UUID REFERENCES marketplace_listings(id),
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, grace, expired, canceled
  last_reminder_stage VARCHAR(10),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_subscriptions_expiry ON subscriptions(expires_at) WHERE status = 'active';

-- Push token registry for the §10.4 reminder service (in-app push).
-- NOTE: not a column-level §7 definition; the table name + purpose come from
-- the §10.4 text ("Push token registry (user_push_tokens), delivery via
-- FCM/Web Push").
CREATE TABLE user_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet VARCHAR(64) NOT NULL,
  device_token TEXT NOT NULL,
  platform VARCHAR(20) NOT NULL, -- fcm, web_push
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_wallet, device_token)
);
CREATE INDEX idx_user_push_tokens_wallet ON user_push_tokens(user_wallet);
