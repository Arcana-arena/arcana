package store

import (
	"context"
	"math/big"
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

// A wallet the fan-out could not reach says so ONCE, not once a minute.
//
// TWO THINGS THAT FAIL SILENTLY IF THEY FAIL. The row a decline writes is the
// only execution row in the system with no transaction behind it, so it is the
// only one that has to satisfy `executions`' NOT NULL columns from nothing —
// and it is written on a path that logs its own failure and carries on, which
// means a schema rejection would never reach anybody. The dedupe is the other:
// without it the cadence writes 1,440 identical true rows a day, which is the
// mistake the guard already made once with 56 duplicate refusal decisions.
func TestADeclineIsRecordedOnceNotEveryTick(t *testing.T) {
	s, agentID := testStore(t)
	ctx := context.Background()

	var subID string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO subscriptions (user_wallet, expires_at, status, agent_id)
		 VALUES ('0xdeclinetest', now() + interval '30 days', 'active', $1) RETURNING id::text`,
		agentID).Scan(&subID); err != nil {
		t.Skipf("could not create a test subscription: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM executions WHERE subscription_id = $1`, subID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM subscriptions WHERE id = $1`, subID)
	})

	const sym = "DECLINETEST"
	had, err := s.RecentRefusalFor(ctx, subID, sym, "insufficient_capital", 24*time.Hour)
	if err != nil {
		t.Fatalf("ask before anything is written: %v", err)
	}
	if had {
		t.Fatalf("a wallet with no history reported a recent refusal, so the FIRST one would " +
			"never be recorded at all")
	}

	// Exactly the row recordSubscriberDecline builds: no transaction, no gas, an
	// amount of zero, and both token sides named.
	if _, err := s.AppendExecution(ctx, ExecutionInsert{
		AgentID: agentID, SubscriptionID: &subID, TS: time.Now().UTC(),
		Wallet: "0x" + "cd", OnBehalfOf: "subscriber",
		IntentAction: "buy", Symbol: sym,
		TokenIn: "0xquote", TokenOut: "0xstock", AmountIn: big.NewInt(0),
		Status: "blocked", RefusalCode: "insufficient_capital",
		Note: "nothing to buy under this subscription's own limits",
	}); err != nil {
		t.Fatalf("the schema rejected a decline row, and the engine would only have LOGGED "+
			"that: %v", err)
	}

	had, err = s.RecentRefusalFor(ctx, subID, sym, "insufficient_capital", 24*time.Hour)
	if err != nil {
		t.Fatalf("ask after: %v", err)
	}
	if !had {
		t.Fatalf("the same refusal was not recognised a moment later, so every tick would write " +
			"another one: 1,440 identical rows a day")
	}

	// A DIFFERENT REASON IS A DIFFERENT FACT, and so is a different symbol.
	// Collapsing them would hide a buyer's wallet emptying behind a stale row
	// about something else.
	for _, c := range []struct{ sym, code string }{
		{sym, "nothing_to_sell"},
		{sym + "2", "insufficient_capital"},
	} {
		had, err := s.RecentRefusalFor(ctx, subID, c.sym, c.code, 24*time.Hour)
		if err != nil {
			t.Fatalf("ask about %s/%s: %v", c.sym, c.code, err)
		}
		if had {
			t.Fatalf("%s/%s was treated as already recorded because a DIFFERENT refusal exists; "+
				"a buyer would never be told about this one", c.sym, c.code)
		}
	}
}
