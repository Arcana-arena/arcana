package store

import (
	"context"
	"testing"
	"time"
)

// An agent is not billed for its customers' gas.
//
// WHY THIS IS A TEST AND NOT A COMMENT. A fan-out execution row carries BOTH
// ids: agent_id, because that agent decided it, and subscription_id, because
// that buyer's funds moved. The agent's cost meter reads by agent_id, so
// without an explicit exclusion a creator would be metered on gas paid out of
// other people's wallets — and a popular agent would be paused for spending
// money it never spent. The exclusion is one line of SQL and is invisible to
// review; it is not invisible to this.
//
// The buyer's side is asserted in the same test, because the two numbers only
// mean anything against each other: the same row must be absent from one window
// and present in the other.
func TestAnAgentIsNotBilledForItsCustomersGas(t *testing.T) {
	s, agentID := testStore(t)
	ctx := context.Background()

	var subID string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO subscriptions (user_wallet, expires_at, status, agent_id)
		 VALUES ('0xcosttest', now() + interval '30 days', 'active', $1) RETURNING id::text`,
		agentID).Scan(&subID); err != nil {
		t.Skipf("could not create a test subscription: %v", err)
	}
	const mark = "cost_test row"
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM executions WHERE note = $1`, mark)
		_, _ = s.pool.Exec(ctx, `DELETE FROM subscriptions WHERE id = $1`, subID)
	})
	_, _ = s.pool.Exec(ctx, `DELETE FROM executions WHERE note = $1`, mark)

	since := time.Now().Add(-time.Hour)
	before, err := s.CostSince(ctx, agentID, since)
	if err != nil {
		t.Fatalf("read the agent's window: %v", err)
	}

	// One row the buyer paid for: the agent decided it, the buyer's wallet
	// burned the gas.
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO executions (agent_id, subscription_id, ts, intent_action, symbol, token_in, token_out, amount_in,
		                         status, gas_cost_wei, gas_cost_usd, note, on_behalf_of)
		 VALUES ($1, $2, now(), 'buy', 'COSTTEST', '0xin', '0xout', 1, 'mined', '1000000000000', 3.50, $3, 'subscriber')`,
		agentID, subID, mark); err != nil {
		t.Fatalf("write the subscriber's execution: %v", err)
	}

	after, err := s.CostSince(ctx, agentID, since)
	if err != nil {
		t.Fatalf("re-read the agent's window: %v", err)
	}
	if after.USD != before.USD || after.Executions != before.Executions {
		t.Fatalf("the agent's cost window moved from $%.2f/%d to $%.2f/%d when a SUBSCRIBER paid "+
			"for gas. A creator metered on their customers' spending would be paused for money "+
			"they never spent",
			before.USD, before.Executions, after.USD, after.Executions)
	}

	sub, err := s.CostSinceSubscription(ctx, subID, since)
	if err != nil {
		t.Fatalf("read the subscriber's window: %v", err)
	}
	if sub.USD != 3.50 || sub.Executions != 1 {
		t.Fatalf("the subscriber's window is $%.2f over %d execution(s), want $3.50 over 1. The "+
			"row has to be absent from one meter AND present in the other; absent from both would "+
			"mean gas nobody is accountable for", sub.USD, sub.Executions)
	}

	// And the creator's own row still counts, so the exclusion has not simply
	// turned the agent's meter off.
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO executions (agent_id, ts, intent_action, symbol, token_in, token_out, amount_in, status,
		                         gas_cost_wei, gas_cost_usd, note, on_behalf_of)
		 VALUES ($1, now(), 'buy', 'COSTTEST', '0xin', '0xout', 1, 'mined', '1000000000000', 1.25, $2, 'creator')`,
		agentID, mark); err != nil {
		t.Fatalf("write the creator's execution: %v", err)
	}
	own, err := s.CostSince(ctx, agentID, since)
	if err != nil {
		t.Fatalf("re-read the agent's window: %v", err)
	}
	if own.USD-before.USD < 1.24 || own.USD-before.USD > 1.26 {
		t.Fatalf("the agent's own $1.25 moved its window by $%.2f. The exclusion must skip the "+
			"customers' rows and nothing else", own.USD-before.USD)
	}
}
