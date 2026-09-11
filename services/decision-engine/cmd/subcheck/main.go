// subcheck answers two questions about subscription trading, THROUGH THE CODE
// THAT DECIDES THEM, and can do nothing else.
//
// WHY A BINARY RATHER THAN A QUERY IN THE SUITE.
//
// Both questions are decided in Go, by predicates the engine actually runs:
//
//	who would this agent trade for right now      store.TradingSubscriptionsFor
//	whose wallet does this guard watch, if any     engine.guardSubjectFor
//
// A verification that re-implemented either as SQL would be checking its own
// idea of the rule rather than the rule. That failure has a name in this
// project — a check that matches itself — and it has been made three times:
// a pgrep that matched its own argv, a docs probe whose literal lived in the
// directory it searched, and a "no tick was opened" that matched the refusal
// message containing the words "opening a tick". This binary exists so the
// answer comes from the same function the engine calls.
//
// WHY IT IS SAFE TO RUN AGAINST PRODUCTION.
//
// Both paths are READ-ONLY BY CONSTRUCTION: they issue SELECTs, they hold no
// lease, they call no broker, they sign nothing, and they write no row. There
// is no flag that makes this binary act. That is the whole reason it can answer
// questions the guard binary refuses to answer under ARCANA_VERIFICATION — the
// guard refuses because ScanOnce can execute; this cannot.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/arcana/decision-engine/internal/engine"
	"github.com/arcana/decision-engine/internal/store"
)

func main() {
	var (
		agentID = flag.String("fanout", "", "agent id: print the subscriptions it would trade for")
		guardID = flag.Int64("guard", 0, "guard id: print whose wallet it watches, or why it stands down")
	)
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := store.NewPool(ctx, dbURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()
	st := store.New(pool)

	switch {
	case *agentID != "":
		subs, err := st.TradingSubscriptionsFor(ctx, *agentID)
		if err != nil {
			log.Fatalf("fan-out: %v", err)
		}
		out := make([]map[string]any, 0, len(subs))
		for _, s := range subs {
			out = append(out, map[string]any{
				"id": s.ID, "wallet": s.Wallet, "user_wallet": s.UserWallet,
				"expires_at": s.ExpiresAt, "risk_profile": s.RiskProfile,
			})
		}
		emit(map[string]any{"agent_id": *agentID, "would_trade_for": out})

	case *guardID != 0:
		// The engine is constructed with no broker and no LLM. Neither is needed
		// to resolve a subject, and a nil broker is a second guarantee that this
		// binary cannot reach the chain even if somebody later teaches the
		// resolution to want a price.
		e := engine.NewForInspection(st)
		g, err := st.GuardByID(ctx, *guardID)
		if err != nil {
			log.Fatalf("guard %d: %v", *guardID, err)
		}
		subj, stand, err := e.InspectGuardSubject(ctx, *g)
		if err != nil {
			log.Fatalf("resolve guard %d: %v", *guardID, err)
		}
		res := map[string]any{"guard_id": *guardID, "symbol": g.Symbol, "status_in_db": g.Status}
		if stand != nil {
			res["stands_down"] = true
			res["reason"] = stand.Why()
			res["permanent"] = stand.IsPermanent()
		} else {
			res["stands_down"] = false
			res["wallet"] = subj.WalletAddress()
			res["signer_id"] = subj.Signer()
			res["cost_budget_monthly_pct"] = subj.BudgetPct()
			res["who"] = subj.Describe()
		}
		emit(res)

	default:
		fmt.Fprintln(os.Stderr, "usage: subcheck -fanout <agent-id> | -guard <guard-id>")
		os.Exit(2)
	}
}

func emit(v any) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		log.Fatalf("encode: %v", err)
	}
	fmt.Println(string(b))
}
