package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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
// WHETHER THIS SKIPS OR FAILS depends on the machine, not on the variable. See
// db_required_test.go: a clone with no Postgres anywhere skips, because it
// genuinely cannot run these. A machine where Postgres is up and only
// DATABASE_URL is missing FAILS, because there the test could have run and did
// not — and an "ok" over a test that did not run is the lie this file's own
// defect was hiding behind.

func testStore(t *testing.T) (*Store, string) {
	t.Helper()
	url := databaseURLForTests(t)
	pool, err := NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("database: %v", err)
	}
	t.Cleanup(pool.Close)
	s := New(pool)

	// An agent that already exists, because position_guards has a foreign key
	// and inventing one would mean inventing a creator and a season too.
	//
	// AN EMPTY TABLE IS AN ABSENCE; ANY OTHER ERROR IS A FAILURE. This used to
	// skip on both, which meant a renamed column or a revoked grant produced a
	// green run — the same defect as skipping for a missing DATABASE_URL, one
	// layer in. No agents at all is a database nobody has traded on yet and
	// genuinely cannot run these. A query that fails for any other reason is
	// drift, which is what these tests are for.
	var agentID string
	err = pool.QueryRow(context.Background(),
		`SELECT id::text FROM agents ORDER BY created_at DESC LIMIT 1`).Scan(&agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		skippedNoFixture.Add(1)
		t.Skip("the agents table is empty, so there is no agent to hang a test guard from — " +
			"SKIPPED, not passed. Seed one agent and this runs.")
	}
	if err != nil {
		t.Fatalf("reading an agent to hang a test guard from: %v\n"+
			"The database answered, so nothing here is absent: the query itself failed. That is the "+
			"schema drift these tests exist to catch, and skipping it reported drift as success.", err)
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

	g, err := s.ArmedGuardFor(ctx, agentID, nil, symbol)
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

// TestASubscriberGuardDoesNotDisarmTheCreatorS proves the wallet scoping.
//
// WHAT IT WOULD HAVE CAUGHT. Every guard query was keyed on (agent_id, symbol)
// because, until subscriptions traded, an agent had exactly one wallet. Arming a
// buyer's level on a symbol the creator also holds would then have run
//
//	UPDATE position_guards SET status='cleared' WHERE agent_id=$1 AND symbol=$2
//
// and silently stood down the CREATOR's stop loss — one customer buying the same
// stock disarming the owner's protection, with nothing in the record to say why.
// The fix is `subscription_id IS NOT DISTINCT FROM $n`; `=` would not do,
// because NULL = NULL is not true and the creator's own top-up would then stop
// clearing its own previous guard.
//
// The assertions run in both directions on purpose: a scoping bug that only
// leaked one way would still be a stop loss watching the wrong money.
func TestASubscriberGuardDoesNotDisarmTheCreators(t *testing.T) {
	s, agentID := testStore(t)
	ctx := context.Background()
	const symbol = "GUARDTEST4"

	var subID string
	err := s.pool.QueryRow(ctx,
		`INSERT INTO subscriptions (user_wallet, expires_at, status, agent_id)
		 VALUES ('0xguardtest', now() + interval '30 days', 'active', $1) RETURNING id::text`,
		agentID).Scan(&subID)
	if err != nil {
		t.Fatalf("could not create a test subscription: %v\n"+
			"NOTHING IS ABSENT HERE. The row is being CREATED, against a database that has already "+
			"answered, on an agent that already exists. An INSERT the schema will not accept is "+
			"drift — a new constraint, a column that moved, a foreign key with nothing behind it — "+
			"and that is the class of defect these tests exist for. This used to skip, which "+
			"reported exactly that as a green run.", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)
		_, _ = s.pool.Exec(ctx, `DELETE FROM subscriptions WHERE id = $1`, subID)
	})
	_, _ = s.pool.Exec(ctx, `DELETE FROM position_guards WHERE symbol = $1`, symbol)

	sl := 95.0
	creator, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, Symbol: symbol, EntryPrice: 100, EntryQty: 1, StopLoss: &sl})
	if err != nil {
		t.Fatalf("arm the creator's guard: %v", err)
	}
	sl2 := 47.5
	buyer, err := s.ArmGuard(ctx, GuardInsert{
		AgentID: agentID, SubscriptionID: &subID, Symbol: symbol,
		EntryPrice: 50, EntryQty: 3, StopLoss: &sl2})
	if err != nil {
		t.Fatalf("arm the subscriber's guard: %v", err)
	}

	status := func(id int64) string {
		var st string
		if err := s.pool.QueryRow(ctx, `SELECT status FROM position_guards WHERE id = $1`, id).Scan(&st); err != nil {
			t.Fatalf("read guard %d: %v", id, err)
		}
		return st
	}
	if st := status(creator); st != "armed" {
		t.Fatalf("the creator's guard is %q after a subscriber armed one on the same symbol; "+
			"one customer disarmed the owner's stop loss", st)
	}
	if st := status(buyer); st != "armed" {
		t.Fatalf("the subscriber's guard is %q, want armed", st)
	}

	// Each side reads back its own level and not the other's.
	g, err := s.ArmedGuardFor(ctx, agentID, nil, symbol)
	if err != nil || g == nil || g.ID != creator {
		t.Fatalf("the creator reads back %v, want guard %d: %v", g, creator, err)
	}
	g, err = s.ArmedGuardFor(ctx, agentID, &subID, symbol)
	if err != nil || g == nil || g.ID != buyer {
		t.Fatalf("the subscriber reads back %v, want guard %d: %v", g, buyer, err)
	}

	// And clearing one leaves the other watching.
	if err := s.ClearGuards(ctx, agentID, &subID, symbol, "the subscriber exited"); err != nil {
		t.Fatalf("clear the subscriber's guard: %v", err)
	}
	if st := status(creator); st != "armed" {
		t.Fatalf("the creator's guard is %q after the SUBSCRIBER exited; the exit cleared the "+
			"wrong wallet's protection", st)
	}
	if st := status(buyer); st != "cleared" {
		t.Fatalf("the subscriber's guard is %q, want cleared", st)
	}
}
