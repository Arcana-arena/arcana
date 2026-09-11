package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// CostWindow is what an agent has actually spent, and how much of a sample that
// is. Everything here is measured; nothing is projected. The projection is the
// caller's job, and it needs the sample size to know whether to trust itself.
type CostWindow struct {
	// USD is gas plus pool fee over the window.
	USD float64
	// Executions is how many swaps contributed. A projection from one trade is
	// not a measurement of anything.
	Executions int
	// Span is how long the window actually covers — from the oldest contributing
	// execution to now, not the nominal window length. An agent three hours old
	// has a three-hour sample however wide the query was.
	Span time.Duration
	// Unpriced is how many executions moved funds and have no dollar cost
	// recorded, because the price feed could not be read at the time.
	//
	// IT IS NOT ZERO COST. A meter that silently treated an unpriced trade as
	// free would under-measure exactly when the chain was misbehaving, which is
	// when measuring matters most. The caller refuses instead.
	Unpriced int
}

// CostSince sums what an agent has spent on gas and pool fees.
//
// It counts EVERY execution that consumed gas, including reverts. A reverted
// swap moved nothing and still burned gas, and this meter bounds spending
// rather than success — the same reason the signature cap counts a signature
// when it is issued rather than when it lands.
//
// IT COUNTS ONLY THE CREATOR'S WALLET. A fan-out execution carries both the
// agent id (which agent decided) and the subscription id (whose funds moved),
// so without the exclusion below a creator's cost meter would bill them for gas
// paid out of their customers' wallets — and an agent would be paused for
// spending money it never spent. The buyer's own meter reads the same rows
// through CostSinceSubscription.
func (s *Store) CostSince(ctx context.Context, agentID string, since time.Time) (CostWindow, error) {
	var w CostWindow
	var oldest *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT
		   coalesce(sum(coalesce(gas_cost_usd,0) + coalesce(pool_fee_usd,0)), 0),
		   count(*) FILTER (WHERE gas_cost_wei IS NOT NULL),
		   count(*) FILTER (WHERE gas_cost_wei IS NOT NULL AND gas_cost_usd IS NULL),
		   min(ts)
		 FROM executions
		 WHERE agent_id = $1 AND subscription_id IS NULL AND ts >= $2`,
		agentID, since).Scan(&w.USD, &w.Executions, &w.Unpriced, &oldest)
	if err != nil {
		return CostWindow{}, fmt.Errorf("read cost window for %s: %w", agentID, err)
	}
	if oldest != nil {
		w.Span = time.Since(*oldest)
	}
	return w, nil
}

// CapitalOf is what the agent has to lose, read from its latest snapshot.
//
// NAV, not the season's initial_capital. For a chain-backed agent the initial
// figure is a season default of 100,000 that has nothing to do with the $11.78
// actually in the wallet, and a cost budget measured against a number that
// large would never bind on anything.
//
// Returns ok=false when there is no snapshot yet. That is not zero capital: it
// is an agent that has not been marked to market, and dividing by it would make
// every cost infinite.
func (s *Store) CapitalOf(ctx context.Context, agentID string) (float64, bool, error) {
	// SCANNED AS TEXT, because nav is numeric and pgx will not put a numeric
	// into a float64. The function beside this one already reads cash as a
	// string for the same reason; the first version of this one did not, every
	// scan failed, and the error was swallowed as "no snapshot yet" -- which
	// PERMITS. A meter that cannot read the capital was quietly letting
	// everything through, which is the exact failure it exists to prevent, and
	// it took the suite driving a $5 cost past a $2 budget to surface it.
	var navText string
	err := s.pool.QueryRow(ctx,
		`SELECT ps.nav::text
		   FROM portfolio_snapshots ps
		   JOIN portfolios p ON p.id = ps.portfolio_id
		  WHERE p.agent_id = $1
		  ORDER BY ps.ts DESC
		  LIMIT 1`, agentID).Scan(&navText)
	if errors.Is(err, pgx.ErrNoRows) {
		// NO SNAPSHOT IS NOT AN ERROR. An agent that has never been marked to
		// market has spent nothing and has no capital to measure against; its
		// first tick has to be allowed to create the snapshot this needs.
		return 0, false, nil
	}
	if err != nil {
		// Anything else is the capital being UNREADABLE, which the caller turns
		// into a pause. Returning ok=false here would be indistinguishable from
		// a new agent, and would fail open.
		return 0, false, fmt.Errorf("read capital for %s: %w", agentID, err)
	}
	nav, perr := strconv.ParseFloat(navText, 64)
	if perr != nil {
		return 0, false, fmt.Errorf("capital for %s is %q, which is not a number: %w", agentID, navText, perr)
	}
	if nav <= 0 {
		return 0, false, nil
	}
	return nav, true, nil
}

// CostSinceSubscription is what ONE BUYER's wallet has spent.
//
// Keyed on subscription_id, so a subscriber's meter counts the gas and pool
// fees paid out of their own wallet and nobody else's. The agent's meter is
// keyed on agent_id and the fan-out rows carry BOTH, which would double-count —
// so the agent's window excludes them; see CostSince.
func (s *Store) CostSinceSubscription(ctx context.Context, subID string, since time.Time) (CostWindow, error) {
	var w CostWindow
	var oldest *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT
		   coalesce(sum(coalesce(gas_cost_usd,0) + coalesce(pool_fee_usd,0)), 0),
		   count(*) FILTER (WHERE gas_cost_wei IS NOT NULL),
		   count(*) FILTER (WHERE gas_cost_wei IS NOT NULL AND gas_cost_usd IS NULL),
		   min(ts)
		 FROM executions
		 WHERE subscription_id = $1 AND ts >= $2`,
		subID, since).Scan(&w.USD, &w.Executions, &w.Unpriced, &oldest)
	if err != nil {
		return CostWindow{}, fmt.Errorf("read cost window for subscription %s: %w", subID, err)
	}
	if oldest != nil {
		w.Span = time.Since(*oldest)
	}
	return w, nil
}

// CapitalOfSubscription is what the BUYER has to lose, from their own book.
//
// subscription_snapshots, never portfolio_snapshots: the agent's NAV series is
// the agent's, and measuring a buyer's budget against the creator's capital
// would let a large creator book excuse any amount of spending in a small one.
//
// ok=false means this buyer has never been marked to market, which is not zero
// capital — same rule, same reason, as CapitalOf.
func (s *Store) CapitalOfSubscription(ctx context.Context, subID string) (float64, bool, error) {
	var navText string
	err := s.pool.QueryRow(ctx,
		`SELECT nav::text FROM subscription_snapshots
		  WHERE subscription_id = $1 ORDER BY ts DESC LIMIT 1`, subID).Scan(&navText)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read capital for subscription %s: %w", subID, err)
	}
	nav, perr := strconv.ParseFloat(navText, 64)
	if perr != nil {
		return 0, false, fmt.Errorf("capital for subscription %s is %q, which is not a number: %w",
			subID, navText, perr)
	}
	if nav <= 0 {
		return 0, false, nil
	}
	return nav, true, nil
}
