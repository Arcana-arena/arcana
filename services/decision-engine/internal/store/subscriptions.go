package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// TradingSubscription is one buyer whose wallet this agent trades for.
//
// The agent decides; this carries everything needed to execute that decision
// against somebody else's money under somebody else's limits.
type TradingSubscription struct {
	ID string
	// UserWallet is the SIWE identity that bought the subscription. It is NOT
	// the trading wallet: the platform cannot sign for an address whose key it
	// does not hold.
	UserWallet string
	// Wallet is derived by the signer from ID. Everything the signer already
	// enforces then applies unchanged — most importantly that proceeds may only
	// reach the wallet it derived, so a subscriber cannot direct execution
	// anywhere else and neither can anyone else.
	Wallet string
	// RiskProfile is the BUYER's, never the creator's.
	RiskProfile map[string]any
	ExpiresAt   time.Time
}

// TradingSubscriptionsFor is every buyer this agent should trade for right now.
//
// THE CONDITIONS ARE THE POINT, so they are spelled out rather than folded into
// a status column:
//
//	status = 'active'      grace is NOT included. Grace keeps a lapsed
//	                       subscriber READING the record, which costs nothing;
//	                       it does not keep spending their money on a
//	                       subscription that has not been paid for.
//	expires_at > now()     the thirty days are real. A status column that has
//	                       not been swept yet is not a licence.
//	not trading_paused     the buyer's own stop, which needs no one's agreement
//	                       and does not wait for expiry.
//	wallet_address is set  a subscription whose wallet was never derived has
//	                       nowhere to execute.
func (s *Store) TradingSubscriptionsFor(ctx context.Context, agentID string) ([]TradingSubscription, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id::text, user_wallet, wallet_address, coalesce(risk_profile, '{}'::jsonb), expires_at
		   FROM subscriptions
		  WHERE agent_id = $1
		    AND status = 'active'
		    AND NOT trading_paused
		    AND wallet_address IS NOT NULL
		    AND expires_at > now()
		  ORDER BY id`, agentID)
	if err != nil {
		return nil, fmt.Errorf("read trading subscriptions for %s: %w", agentID, err)
	}
	defer rows.Close()

	var out []TradingSubscription
	for rows.Next() {
		var t TradingSubscription
		var raw []byte
		if err := rows.Scan(&t.ID, &t.UserWallet, &t.Wallet, &raw, &t.ExpiresAt); err != nil {
			return nil, fmt.Errorf("scan subscription: %w", err)
		}
		t.RiskProfile = map[string]any{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &t.RiskProfile); err != nil {
				// A PROFILE THAT CANNOT BE READ IS NOT AN EMPTY ONE. Defaulting
				// here would size a stranger's position with the platform's
				// limits rather than the ones they set.
				//
				// SO THIS SUBSCRIPTION IS SKIPPED — AND ONLY THIS ONE.
				//
				// The first version returned an error for the whole list, which
				// meant one malformed profile stopped the agent trading for
				// every other buyer as well. That breaks the rule this design is
				// built on: one wallet failing must never fail the others. It is
				// the same rule as one expensive agent not silencing its
				// neighbour, and it cost nothing to get wrong here because
				// nobody had a malformed profile yet.
				log.Printf("ERROR subscription %s has an unreadable risk_profile (%v); it is left "+
					"OUT of this fan-out and every other subscriber is unaffected", t.ID, err)
				continue
			}
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SubscriptionSnapshot marks a buyer's book to market.
//
// Deliberately not portfolio_snapshots: the Scoring Engine reads that table by
// agent, and a subscriber's holdings entering the agent's NAV series would
// change the agent's score — which is the one thing this whole design must not
// do.
func (s *Store) WriteSubscriptionSnapshot(ctx context.Context, subID string, ts time.Time,
	holdings map[string]any, nav, cash string, decisionID *int64) error {

	raw, err := json.Marshal(holdings)
	if err != nil {
		return fmt.Errorf("encode subscription holdings: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO subscription_snapshots (subscription_id, ts, nav, cash, holdings, decision_id)
		 VALUES ($1, $2, $3::numeric, $4::numeric, $5::jsonb, $6)`,
		subID, ts, nav, cash, raw, decisionID)
	if err != nil {
		return fmt.Errorf("write subscription snapshot for %s: %w", subID, err)
	}
	return nil
}

// LastSubscriptionHoldings is what ARCANA last recorded this buyer holding, for
// the custody reconciliation. ok=false means nothing has been recorded yet,
// which is not the same as holding nothing.
func (s *Store) LastSubscriptionHoldings(ctx context.Context, subID string) (map[string]any, float64, bool, error) {
	var raw []byte
	var cashStr string
	err := s.pool.QueryRow(ctx,
		`SELECT holdings, cash::text FROM subscription_snapshots
		  WHERE subscription_id = $1 ORDER BY ts DESC LIMIT 1`, subID).Scan(&raw, &cashStr)
	if err != nil {
		return nil, 0, false, nil
	}
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	var cash float64
	_, _ = fmt.Sscanf(cashStr, "%f", &cash)
	return out, cash, true, nil
}

// AnyFundedSubscriptionWallet reports whether this agent has a subscriber whose
// wallet could be spent from.
//
// Used by the verification refusal: the engine already declines to act on an
// agent that holds a wallet, and a fan-out means a verification could reach
// several more that the agent row says nothing about.
func (s *Store) AnyFundedSubscriptionWallet(ctx context.Context, agentID string) (string, bool, error) {
	var wallet string
	err := s.pool.QueryRow(ctx,
		`SELECT wallet_address FROM subscriptions
		  WHERE agent_id = $1 AND wallet_address IS NOT NULL LIMIT 1`, agentID).Scan(&wallet)
	if err != nil {
		return "", false, nil
	}
	return wallet, true, nil
}

// SubscriptionByID is one buyer, whatever their subscription's state.
//
// NOT SCOPED TO ACTIVE. A protective exit on an expired subscription is still
// refused elsewhere — trading stops at expiry — but the guard path needs to be
// able to READ the subscription in order to say so, and a lookup that returns
// nothing would make "expired" indistinguishable from "never existed".
func (s *Store) SubscriptionByID(ctx context.Context, subID string) (*TradingSubscription, string, error) {
	var t TradingSubscription
	var status string
	var raw []byte
	var wallet *string
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, user_wallet, wallet_address, coalesce(risk_profile,'{}'::jsonb),
		        expires_at, status
		   FROM subscriptions WHERE id = $1`, subID).
		Scan(&t.ID, &t.UserWallet, &wallet, &raw, &t.ExpiresAt, &status)
	if err != nil {
		return nil, "", fmt.Errorf("read subscription %s: %w", subID, err)
	}
	if wallet != nil {
		t.Wallet = *wallet
	}
	t.RiskProfile = map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &t.RiskProfile); err != nil {
			return nil, "", fmt.Errorf("subscription %s has an unreadable risk_profile: %w", subID, err)
		}
	}
	return &t, status, nil
}

// TradingAllowed reports whether the agent may still act for this subscription.
//
// The same conditions as TradingSubscriptionsFor, asked about one row. Kept
// beside it on purpose: two places deciding whether a buyer is still being
// traded for would eventually disagree, and the disagreement would be somebody
// being traded for after they stopped paying.
func (s *Store) TradingAllowed(ctx context.Context, subID string) (bool, string, error) {
	var allowed bool
	var reason string
	err := s.pool.QueryRow(ctx,
		`SELECT status = 'active' AND NOT trading_paused AND wallet_address IS NOT NULL
		        AND expires_at > now(),
		        CASE
		          WHEN wallet_address IS NULL THEN 'no trading wallet has been derived'
		          WHEN trading_paused THEN 'the subscriber has paused trading'
		          WHEN expires_at <= now() THEN 'the subscription expired at ' || expires_at::text
		          WHEN status <> 'active' THEN 'the subscription is ' || status
		          ELSE ''
		        END
		   FROM subscriptions WHERE id = $1`, subID).Scan(&allowed, &reason)
	if err != nil {
		return false, "", fmt.Errorf("read trading state for %s: %w", subID, err)
	}
	return allowed, reason, nil
}
