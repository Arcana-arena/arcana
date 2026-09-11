package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// The guard lifecycle, against a real database.
//
// WHY THIS FILE EXISTS. CloseGuard shipped with a query Postgres refuses:
//
//	ERROR: inconsistent types deduced for parameter $2 (SQLSTATE 42P08)
//
// $2 appeared twice — once as `status = $2`, inferred varchar from the column,
// and once inside `CASE WHEN $2 = 'triggered'`, inferred text from the literal.
// Every Go test passed, the engine built, the suite that drives the lease passed
// 25/25, and the defect was invisible until a stop loss fired against real money
// on the live chain: the exit executed, the transaction mined, and the guard
// could not be closed. The row stayed `armed` over a position that no longer
// existed while the heartbeat counted it as gone.
//
// A query is not exercised by compiling it. These run against the database.
//
// SKIPPED WITHOUT DATABASE_URL, so a machine with no Postgres still runs the
// rest of the suite — but the deploy path sets it, and a skip is reported as a
// skip rather than as a pass.

func testStore(t *testing.T) (*Store, string) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; this test needs a real database because the defect it " +
			"exists for was a query the planner rejects, not anything the compiler can see")
	}
	pool, err := NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("database: %v", err)
	}
	t.Cleanup(pool.Close)
	s := New(pool)

	// An agent that already exists, because position_guards has a foreign key
	// and inventing one would mean inventing a creator and a season too.
	var agentID string
	if err := pool.QueryRow(context.Background(),
		`SELECT id::text FROM agents ORDER BY created_at DESC LIMIT 1`).Scan(&agentID); err != nil {
		t.Skipf("no agent to hang a test guard from: %v", err)
	}
	return s, agentID
}

func TestGuardCanActuallyBeClosed(t *testing.T) {
	s, agentID := testStore(t)
	ctx := context.Background()
	const symbol = "GUARDTEST"

	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)
	})
	_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)

	sl, tp := 95.0, 110.0
	id, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, Symbol: symbol, EntryPrice: 100, EntryQty: 1,
		StopLoss: &sl, TakeProfit: &tp, Note: "guards_test",
	})
	if err != nil {
		t.Fatalf("arm: %v", err)
	}

	// THE CALL THAT FAILED IN PRODUCTION. Every argument populated, because the
	// broken parameter was one the happy path always fills.
	price := 94.5
	decID := int64(0)
	ok, err := s.CloseGuard(ctx, id, "triggered", "stop_loss", &price, nil, "closed by guards_test")
	if err != nil {
		t.Fatalf("close: %v", err)
	}
	if !ok {
		t.Fatal("close reported that no armed guard was updated")
	}
	_ = decID

	var status, side string
	var at *time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT status, coalesce(triggered_side,''), triggered_at FROM position_guards WHERE id = $1`,
		id).Scan(&status, &side, &at); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != "triggered" {
		t.Fatalf("status is %q after closing", status)
	}
	if side != "stop_loss" {
		t.Fatalf("triggered_side is %q", side)
	}
	if at == nil {
		t.Fatal("triggered_at was not stamped, so the CASE branch did not run")
	}

	// A SECOND CLOSE MUST LOSE. The WHERE clause insists the guard is still
	// armed, so two writers cannot both claim the exit.
	again, err := s.CloseGuard(ctx, id, "expired", "", nil, nil, "second writer")
	if err != nil {
		t.Fatalf("second close errored instead of losing: %v", err)
	}
	if again {
		t.Fatal("a guard that was already closed was closed again")
	}
}

func TestGuardCanBeExpiredWithNothingToRecord(t *testing.T) {
	// The other shape: a guard over a position that is gone. Every optional
	// argument is nil or empty, which is a different set of inferred types from
	// the case above and is how the scan path calls it.
	s, agentID := testStore(t)
	ctx := context.Background()
	const symbol = "GUARDTEST2"

	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)
	})
	_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)

	sl := 95.0
	id, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, Symbol: symbol, EntryPrice: 100, EntryQty: 1, StopLoss: &sl,
	})
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	ok, err := s.CloseGuard(ctx, id, "expired", "", nil, nil, "nothing left to guard")
	if err != nil {
		t.Fatalf("expire: %v", err)
	}
	if !ok {
		t.Fatal("expire reported that no armed guard was updated")
	}

	var status string
	var at *time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT status, triggered_at FROM position_guards WHERE id = $1`, id).Scan(&status, &at); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != "expired" {
		t.Fatalf("status is %q", status)
	}
	if at != nil {
		t.Fatal("triggered_at was stamped on a guard that never triggered")
	}
}

func TestArmingReplacesTheGuardItTopsUp(t *testing.T) {
	s, agentID := testStore(t)
	ctx := context.Background()
	const symbol = "GUARDTEST3"

	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)
	})
	_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)

	sl := 95.0
	first, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, Symbol: symbol, EntryPrice: 100, EntryQty: 1, StopLoss: &sl})
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	// The unique index allows one armed guard per agent and symbol, so a top-up
	// must clear the old one in the same transaction or hit the constraint.
	sl2 := 190.0
	second, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, Symbol: symbol, EntryPrice: 200, EntryQty: 2, StopLoss: &sl2})
	if err != nil {
		t.Fatalf("top up: %v", err)
	}

	g, err := s.ArmedGuardFor(ctx, agentID, symbol)
	if err != nil {
		t.Fatalf("read armed: %v", err)
	}
	if g == nil || g.ID != second {
		t.Fatalf("the armed guard is %v, want %d", g, second)
	}
	if g.EntryPrice != 200 {
		t.Fatalf("entry price is %v, want 200", g.EntryPrice)
	}

	var old string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM position_guards WHERE id = $1`, first).Scan(&old); err != nil {
		t.Fatalf("read the replaced guard: %v", err)
	}
	if old != "cleared" {
		t.Fatalf("the replaced guard is %q, not cleared — its history was lost or it is still armed", old)
	}
}
