// Command leaserace exists so the execution lease can be proved under a REAL
// race rather than by reading the branch that handles one.
//
// guard-verify starts two of these at once against the same agent, with a
// shared start instant, and asserts that exactly one acquires the lease and the
// other is told who holds it without waiting. That is the collision the lease
// exists for: the decision cycle and the position guard both deciding to move
// the same funds in the same instant.
//
// It is a verification tool, not a service. Nothing installs it and nothing
// schedules it; it lives here because Go's internal/ rule means only code
// inside this module can use the real store, and using the real store is the
// entire point — a race proved against a reimplementation of the lease would
// prove something about the reimplementation.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Println("ERR usage: leaserace <agent-id> <holder> <rfc3339nano start>")
		return
	}
	ctx := context.Background()
	pool, err := store.NewPool(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fmt.Println("ERR", err)
		return
	}
	defer pool.Close()
	st := store.New(pool)
	agent, holder := os.Args[1], os.Args[2]

	// A SHARED START INSTANT. Without it the two processes reach the lease
	// whenever they happen to finish booting, and the result would be a
	// measurement of process start-up rather than of contention.
	at, perr := time.Parse(time.RFC3339Nano, os.Args[3])
	if perr != nil {
		fmt.Println("ERR", perr)
		return
	}
	time.Sleep(time.Until(at))

	err = st.AcquireLease(ctx, agent, holder, 30*time.Second, "leaserace")
	switch {
	case err == nil:
		fmt.Println("ACQUIRED", holder)
	case errors.Is(err, store.ErrLeaseHeld):
		who, until, ok, _ := st.LeaseHolder(ctx, agent)
		fmt.Println("HELD", holder, "by", who, ok, until.Format(time.RFC3339))
	default:
		fmt.Println("ERR", err)
	}
}
