-- ============================================================================
-- 0023 — authentication: SIWE sessions, single-use nonces, verified ownership.
--
-- Until this migration ARCANA had no auth at all: every endpoint took the
-- caller's identity from the request body. This adds the storage that lets a
-- wallet PROVE it owns a creator row instead of merely naming one.
--
-- It also retires the pre-auth creators. See the block at the bottom for why
-- they are frozen rather than made claimable.
-- ============================================================================

-- --- creators: ownership is now a verified fact, not an attribute -----------

-- NULL means "no wallet has ever proven control of this creator". Every write
-- path that touches an agent requires a non-NULL value here, so a creator that
-- predates auth cannot be driven by anyone.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ;

-- 'siwe'        — created by a wallet that completed a sign-in.
-- 'legacy_seed' — existed before auth; frozen, read-only, unclaimable.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'siwe';

-- Where a withdrawn pre-auth wallet is recorded. This is an audit note, never
-- an identity: nothing in the codebase reads it to make an access decision.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS legacy_wallet_note TEXT;

-- --- single-use sign-in nonces ---------------------------------------------

-- A nonce is issued unbound (we do not know the wallet until the signature
-- arrives) and may be redeemed exactly once. `used_at` is what makes a replayed
-- signature fail; see the atomic UPDATE ... RETURNING in AuthService.
CREATE TABLE auth_nonces (
  nonce      VARCHAR(64) PRIMARY KEY,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Supports both the expiry sweep and the "is this nonce still redeemable" read.
CREATE INDEX idx_auth_nonces_expires_at ON auth_nonces (expires_at);

-- --- refresh sessions -------------------------------------------------------

-- Access tokens are stateless JWTs and are NOT stored. Only refresh tokens live
-- here, and only as a SHA-256 hash: a database leak must not yield usable
-- tokens.
--
-- `family_id` ties every rotation of one sign-in together. Presenting a refresh
-- token that was already used means it leaked, so the whole family is revoked
-- rather than just that one row.
CREATE TABLE auth_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address     VARCHAR(64) NOT NULL,
  family_id          UUID NOT NULL,
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  revoked_reason     VARCHAR(40)
);

CREATE INDEX idx_auth_sessions_wallet ON auth_sessions (wallet_address);
CREATE INDEX idx_auth_sessions_family ON auth_sessions (family_id);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- --- freeze the pre-auth creators -------------------------------------------
--
-- Every creator that exists at this point was created without proving anything.
-- One of them (dummy_creator) carries 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
-- — Anvil/Hardhat's default account #2, whose private key is published in the
-- Foundry docs and thousands of tutorials.
--
-- That single fact rules out the obvious migration path. "Sign with the wallet
-- on record to claim your creator" would hand all nine existing agents — three
-- of them actively competing in Season 2 — to whoever notices first. A claim
-- endpoint here is not a safeguard, it is a race.
--
-- So the wallet is WITHDRAWN rather than guarded, and these rows are frozen:
-- readable forever (leaderboard, passport, DNA, autopsy), writable by nobody.
-- Taking one over is a manual SQL statement run by the operator after signing
-- in with a real wallet — deliberately not something the API can do.
UPDATE creators
SET origin             = 'legacy_seed',
    wallet_verified_at = NULL,
    legacy_wallet_note = CASE
      WHEN wallet_address IS NOT NULL THEN
        'withdrawn_wallet=' || wallet_address ||
        '; reason=pre-auth seed row, wallet was never proven and is a publicly ' ||
        'known test key; frozen by migration 0023'
      ELSE
        'reason=pre-auth seed row with no wallet on record; frozen by migration 0023'
    END,
    wallet_address     = NULL;
