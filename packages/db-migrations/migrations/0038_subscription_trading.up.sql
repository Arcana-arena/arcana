-- 0038_subscription_trading.up.sql
-- What a marketplace subscription actually buys: the agent trades for you too.
--
-- WHAT WAS WRONG. The payment flow worked and bought nothing. Every track
-- record on this platform is public — the Passport, the score series, the
-- decision log, the DNA — so a subscription gated a door with nothing behind
-- it. `access: true` meant the right to read what everyone could already read.
--
-- WHAT IT BUYS NOW. One agent, one mandate, executing in SEVERAL wallets: the
-- creator's and each subscriber's. The same decision, each wallet's own funds.
--
-- OWNERSHIP DOES NOT MOVE. This is not a copy of the agent. There is still one
-- agent, it still belongs to its creator, and a subscription is a right to have
-- its decisions executed against your money for thirty days.
--
-- ============================================================================
-- 1. A SUBSCRIPTION GETS ITS OWN WALLET.
-- ============================================================================
--
-- WHY DERIVED RATHER THAN THE SUBSCRIBER'S OWN ADDRESS. The platform signs; it
-- cannot sign for an address whose key it does not hold. So a subscription's
-- trading wallet is derived by the signer from the SUBSCRIPTION ID, exactly the
-- way an agent's is derived from its agent id — and every rule the signer
-- already enforces then applies unchanged:
--
--   * `recipient_not_agent_wallet` forces proceeds to the wallet derived for
--     that id and nowhere else. A subscriber cannot direct execution into
--     somebody else's wallet, because the signer does not take a recipient — it
--     computes one.
--   * the daily signature cap keys on that id, so it is already PER WALLET.
--   * the export path already exists, so a subscriber can take the key and
--     withdraw whatever is left whenever they like.
--
-- The subscriber funds this wallet themselves, in USDG for trading and ETH for
-- gas. Nobody else's money is in it.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42),

  -- ============================================================================
  -- 2. THE BUYER SIZES THE POSITION, THE CREATOR CHOOSES THE DIRECTION.
  -- ============================================================================
  --
  -- The creator's risk_profile sizes the CREATOR's wallet and nothing else.
  -- Applying it to a subscriber would mean a creator who set trade_size_pct 0.5
  -- for an $11 book commits half of a $50,000 one to a single idea — the
  -- platform handing one person's risk appetite to another person's money.
  --
  -- So a subscription carries its own limits, set by the buyer, defaulting to
  -- the platform defaults rather than to the creator's. What the agent produces
  -- is a DIRECTION and a fraction of the book; each wallet resolves that against
  -- its own capital under its own limits.
  --
  -- Same keys as agents.risk_profile, read by the same riskLimitsFrom().
  ADD COLUMN IF NOT EXISTS risk_profile JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Denormalised from the listing so the fan-out can find subscribers by agent
  -- without joining two tables on every tick. Written once at subscribe time.
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id),

  -- The subscriber's own stop, independent of everything else. A buyer must be
  -- able to halt trading in their wallet without waiting for expiry and without
  -- asking the creator.
  ADD COLUMN IF NOT EXISTS trading_paused BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_wallet
  ON subscriptions (wallet_address) WHERE wallet_address IS NOT NULL;

-- Finding who to trade for, which happens on every tick.
CREATE INDEX IF NOT EXISTS idx_subscriptions_trading
  ON subscriptions (agent_id) WHERE status = 'active' AND wallet_address IS NOT NULL;

COMMENT ON COLUMN subscriptions.wallet_address IS
  'The trading wallet derived by the signer from this subscription id. Funded '
  'by the subscriber, exportable by the subscriber, and the only address the '
  'signer will send this subscription''s proceeds to.';

COMMENT ON COLUMN subscriptions.risk_profile IS
  'The BUYER''s limits, not the creator''s. The creator decides direction; the '
  'buyer decides how much is at stake. Empty means the platform defaults.';

-- ============================================================================
-- 3. WHOSE RECORD IS IT.
-- ============================================================================
--
-- ONE DECISION, N EXECUTIONS, AND THEY ARE DIFFERENT KINDS OF FACT.
--
-- The ARCANA Score is computed on DECISION QUALITY — that was settled in
-- on-chain-direction.md §a, marked against a reference price so the score
-- measures judgement rather than luck of fill. One decision is one decision
-- however many wallets executed it, so nothing about a subscriber changes the
-- agent's score, DNA or Autopsy. An agent whose number moved because it gained
-- customers would be measuring its sales, not its trading.
--
-- Execution quality is the other half, and it is a fact about a WALLET: this
-- fill, this slippage, this gas, in this account. A subscriber's fills are
-- their record, not the agent's.
--
-- So: the decision row stays singular and belongs to the agent. Execution rows
-- multiply and each one says whose wallet it was for. Neither is folded into
-- the other, and the agent's portfolio never sees a subscriber's holdings —
-- which also keeps the Scoring Engine's NAV series untouched, since it reads
-- `portfolios` by agent_id and subscribers are not in it.
ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id),
  -- The wallet this execution moved funds in. Recorded rather than inferred:
  -- an execution that cannot name its own account is one nobody can reconcile.
  ADD COLUMN IF NOT EXISTS wallet VARCHAR(42),
  -- creator | subscriber. NULL on every row written before subscriptions
  -- traded, which is honest: they predate the distinction, and every one of
  -- them was the creator's.
  ADD COLUMN IF NOT EXISTS on_behalf_of VARCHAR(16);

CREATE INDEX IF NOT EXISTS idx_executions_subscription
  ON executions (subscription_id, ts DESC) WHERE subscription_id IS NOT NULL;

COMMENT ON COLUMN executions.on_behalf_of IS
  'Whose funds moved: creator or subscriber. The agent''s score, DNA and '
  'Autopsy read only the creator''s; a subscriber''s own record reads theirs. '
  'Same shape as decisions.decider separating protective from own — the record '
  'must not lie about who an action was for.';

-- ============================================================================
-- 4. THE SUBSCRIBER'S OWN BOOK.
-- ============================================================================
--
-- Deliberately NOT portfolio_snapshots. The Scoring Engine reads that table by
-- agent, and writing subscriber holdings into it would fold N books into one
-- NAV series and change the agent's score — which is the one thing this design
-- must not do.
CREATE TABLE IF NOT EXISTS subscription_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id UUID        NOT NULL REFERENCES subscriptions(id),
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  nav             NUMERIC(20,2) NOT NULL,
  cash            NUMERIC(20,2) NOT NULL,
  holdings        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- The decision this snapshot followed, so a subscriber can read their book
  -- against the reasoning that produced it.
  decision_id     BIGINT
);

CREATE INDEX IF NOT EXISTS idx_subscription_snapshots
  ON subscription_snapshots (subscription_id, ts DESC);

COMMENT ON TABLE subscription_snapshots IS
  'A subscriber''s own book, marked to market on every tick the agent traded '
  'for them. Separate from portfolio_snapshots on purpose: the Scoring Engine '
  'reads that table by agent, and a subscriber''s holdings must never enter the '
  'agent''s NAV series.';

-- ============================================================================
-- 5. AN EXPIRED SUBSCRIPTION LEAVES THE POSITION WHERE IT IS.
-- ============================================================================
--
-- DECIDED, and written here because it is the surprising half. The agent stops
-- trading for that wallet; whatever is open stays open. It is not liquidated on
-- the subscriber's behalf, because choosing the moment to sell somebody's
-- position is a trading decision nobody asked the platform to make.
--
-- What must hold is that the subscriber is never LOCKED IN: the wallet is
-- exportable, the holdings are readable, and neither depends on the
-- subscription being active. Both are properties of the wallet, not of the
-- subscription, so expiry cannot take them away.
COMMENT ON COLUMN subscriptions.status IS
  'active | grace | expired | canceled. Trading happens only while active and '
  'not paused. An expired subscription stops the agent trading for that wallet '
  'and does NOT close its positions: the subscriber keeps the wallet, can '
  'export its key, and can read and withdraw whatever is in it.';
