-- 0027_payment_claims.up.sql
-- How ARCANA learns that a marketplace payment happened, now that it never
-- receives one.
--
-- THE MODEL. The marketplace is P2P with no fee: the buyer transfers $ARCA
-- straight to the creator's wallet and submits the transaction hash. ARCANA
-- verifies it against the chain and grants access. No deposit address it
-- controls, no treasury, no split, no contract (docs/on-chain-direction.md §g).
--
-- WHAT THIS TABLE IS FOR, and it is not bookkeeping. It is the anti-replay
-- record. A transaction hash is PUBLIC the moment it is mined: anyone watching
-- the chain can see a payment to a creator and try to claim it, and the buyer
-- can try to spend the same payment on every listing that creator sells. Both
-- attacks are free to mount and neither needs any access to ARCANA.
--
-- SO THE UNIQUE IS ON tx_hash ALONE, NOT ON (tx_hash, listing_id).
--
-- That distinction is the whole design. Keyed by the pair, one payment would
-- buy every listing a creator has ever published — the same hash, a different
-- listing_id, a new row each time, and every insert succeeding. Keyed by the
-- hash, the second claim collides no matter what it is claiming, and the
-- database refuses it without the application having to remember to ask.
--
-- The old §10 design had `payment_events.tx_hash UNIQUE` too, but there it was
-- tidiness: payments were matched to a deposit address ARCANA generated, so a
-- stranger could not submit one. Here it is load-bearing, and the verification
-- suite proves it refuses rather than assuming it does.

CREATE TABLE IF NOT EXISTS payment_claims (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE GUARD. One claim per transaction, for all time and all listings.
  tx_hash        VARCHAR(80) UNIQUE NOT NULL,

  listing_id     UUID NOT NULL REFERENCES marketplace_listings(id),

  -- Recorded as verified ON CHAIN, not as supplied by the caller. The claimer
  -- says which transaction; the chain says who paid whom.
  buyer_wallet   VARCHAR(64) NOT NULL,
  creator_wallet VARCHAR(64) NOT NULL,
  token_address  VARCHAR(64) NOT NULL,
  amount         NUMERIC(78,0) NOT NULL,   -- base units; 78 digits covers uint256

  -- Evidence of WHEN, so a later reader can judge the freshness rule that was
  -- applied rather than trusting that one was.
  block_number   BIGINT NOT NULL,
  block_time     TIMESTAMPTZ NOT NULL,
  confirmations  INT NOT NULL,

  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by     VARCHAR(64) NOT NULL      -- the signed-in wallet that claimed
);

COMMENT ON TABLE payment_claims IS
  'One row per marketplace payment verified on chain. tx_hash is UNIQUE across '
  'the whole table, not per listing: a single payment must not buy two things. '
  'Replaces the §10 deposit-address flow, which is retired in a later phase now '
  'that this exists.';

COMMENT ON COLUMN payment_claims.tx_hash IS
  'UNIQUE, and this is the anti-replay guard rather than an index. A tx hash is '
  'public the moment it is mined, so both attacks it stops — a stranger claiming '
  'somebody else''s payment, and a buyer spending one payment on many listings — '
  'are free to mount and need no access to ARCANA.';

COMMENT ON COLUMN payment_claims.buyer_wallet IS
  'The `from` of the verified on-chain transfer. NOT what the caller said: the '
  'claimer names a transaction, the chain names who paid.';

-- Reading a creator's or a buyer's history.
CREATE INDEX IF NOT EXISTS idx_payment_claims_listing ON payment_claims (listing_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_claims_buyer   ON payment_claims (buyer_wallet, claimed_at DESC);
