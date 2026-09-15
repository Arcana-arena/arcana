// Command fills rebuilds the fill ledger (position_fills, 0051) for trades
// that happened before it existed.
//
// FROM THE RECORD ONLY, NEVER FROM AN ESTIMATE:
//
//	on chain   every mined buy/sell in `executions`: quote units against share
//	           units as the chain moved them, gas from the execution and its
//	           approval. The agent's own book and each subscriber's.
//	virtual    every buy/sell decision of an agent with no wallet, at the price
//	           in the market snapshot that decision names — which is the price
//	           the virtual settlement used.
//
// What the book held before each fill is read from the snapshot recorded just
// before it, so shares that arrived outside ARCANA are named as having no known
// cost rather than being priced at the next fill.
//
// SAFE TO RUN AGAIN. A fill already in the ledger (same execution, or the same
// decision in the agent's book) is skipped, and nothing is ever inserted before
// a fill already recorded for the same book and symbol — the accounting is
// sequential, and an insert into the past would make every later row wrong.
//
//	DATABASE_URL=... MARKET_DATA_URL=... EXECUTION_ALLOWLIST_FILE=... fills [-dry-run]
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
)

type event struct {
	ts         time.Time
	id         int64 // execution id or decision id, for ordering ties
	agentID    string
	book       store.FillBook
	decisionID *int64
	execID     *int64
	symbol     string
	side       string
	qty        float64
	price      float64
	gasUSD     *float64
	poolFeeUSD *float64
	heldBefore float64
}

func main() {
	dry := flag.Bool("dry-run", false, "print what would be recorded and write nothing")
	flag.Parse()
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()
	st := store.New(pool)
	md := marketdata.New(mustEnv("MARKET_DATA_URL"))
	cfg, err := execution.LoadConfig(mustEnv("EXECUTION_ALLOWLIST_FILE"))
	if err != nil {
		log.Fatalf("allowlist: %v", err)
	}

	var events []event
	skipped := map[string]int{}

	// ---- on chain -------------------------------------------------------
	rows, err := pool.Query(ctx, `
		SELECT e.id, e.agent_id::text, e.decision_id, e.subscription_id::text, e.ts, e.intent_action, e.symbol,
		       e.amount_in::text, e.filled_out::text, e.gas_cost_usd::float8, e.pool_fee_usd::float8,
		       (SELECT sum(ap.gas_cost_usd)::float8 FROM executions ap
		         WHERE ap.intent_action = 'approve' AND ap.status = 'mined' AND ap.agent_id = e.agent_id
		           AND ap.wallet IS NOT DISTINCT FROM e.wallet AND ap.symbol = e.symbol
		           AND ap.ts BETWEEN e.ts - interval '2 minutes' AND e.ts + interval '2 minutes') AS approve_gas,
		       (SELECT p.id::text FROM portfolios p
		          -- raw-by-design: reconstructing every fill that changed a book, including rows later marked as artefacts
		          JOIN decisions d ON d.id = e.decision_id AND d.agent_id = e.agent_id
		         WHERE p.agent_id = e.agent_id AND p.season_id = d.season_id LIMIT 1) AS portfolio_id
		  FROM executions e
		 WHERE e.status = 'mined' AND e.intent_action IN ('buy', 'sell')
		   AND e.amount_in > 0 AND e.filled_out > 0
		   AND NOT EXISTS (SELECT 1 FROM position_fills f WHERE f.execution_id = e.id)`)
	if err != nil {
		log.Fatalf("read executions: %v", err)
	}
	for rows.Next() {
		var (
			id                   int64
			agentID, action, sym string
			decisionID           *int64
			subID, portfolioID   *string
			ts                   time.Time
			amountIn, filled     string
			gas, poolFee, apGas  *float64
		)
		if err := rows.Scan(&id, &agentID, &decisionID, &subID, &ts, &action, &sym, &amountIn, &filled,
			&gas, &poolFee, &apGas, &portfolioID); err != nil {
			log.Fatalf("scan execution: %v", err)
		}
		tok, terr := cfg.Token(sym)
		if terr != nil {
			skipped["symbol not in allowlist"]++
			continue
		}
		in, _ := new(big.Int).SetString(amountIn, 10)
		out, _ := new(big.Int).SetString(filled, 10)
		var shares, quote float64
		if action == "buy" {
			quote, shares = units(in, cfg.QuoteToken.Decimals), units(out, tok.Decimals)
		} else {
			shares, quote = units(in, tok.Decimals), units(out, cfg.QuoteToken.Decimals)
		}
		if shares <= 0 || quote <= 0 {
			skipped["no measurable amounts"]++
			continue
		}
		ev := event{ts: ts, id: id, agentID: agentID, decisionID: decisionID, symbol: sym, side: action,
			qty: shares, price: quote / shares, poolFeeUSD: poolFee}
		eid := id
		ev.execID = &eid
		if gas != nil {
			g := *gas
			if apGas != nil {
				g += *apGas
			}
			ev.gasUSD = &g
		}
		if subID != nil {
			ev.book = store.FillBook{SubscriptionID: *subID}
		} else if portfolioID != nil {
			ev.book = store.FillBook{PortfolioID: *portfolioID}
		} else {
			skipped["creator execution with no decision to name its season"]++
			continue
		}
		events = append(events, ev)
	}
	rows.Close()

	// ---- virtual --------------------------------------------------------
	vrows, err := pool.Query(ctx, `
		SELECT d.id, d.agent_id::text, d.ts, d.action, d.symbol, d.quantity::float8, d.market_snapshot_ref, p.id::text
		  -- raw-by-design: reconstructing every fill that changed a book, including rows later marked as artefacts
		  FROM decisions d
		  JOIN portfolios p ON p.agent_id = d.agent_id AND p.season_id = d.season_id
		 WHERE d.action IN ('buy', 'sell') AND d.quantity > 0
		   AND NOT EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = d.agent_id)
		   AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.decision_id = d.id AND e.subscription_id IS NULL)
		   AND NOT EXISTS (SELECT 1 FROM position_fills f WHERE f.decision_id = d.id AND f.book = 'agent')`)
	if err != nil {
		log.Fatalf("read decisions: %v", err)
	}
	type vrow struct {
		id                      int64
		agentID, action, sym    string
		ts                      time.Time
		qty                     float64
		ref, portfolioID        string
	}
	var vs []vrow
	for vrows.Next() {
		var r vrow
		if err := vrows.Scan(&r.id, &r.agentID, &r.ts, &r.action, &r.sym, &r.qty, &r.ref, &r.portfolioID); err != nil {
			log.Fatalf("scan decision: %v", err)
		}
		vs = append(vs, r)
	}
	vrows.Close()

	prices := map[string]map[string]float64{}
	for _, r := range vs {
		p, ok := prices[r.ref]
		if !ok {
			snap, serr := md.GetSnapshot(ctx, r.ref)
			if serr != nil {
				log.Printf("snapshot %s unreadable, its decisions are not reconstructed: %v", r.ref, serr)
				prices[r.ref] = nil
				skipped["market snapshot unreadable"]++
				continue
			}
			p = map[string]float64{}
			for _, q := range snap.Symbols {
				p[q.Symbol] = q.Price
			}
			prices[r.ref] = p
		}
		if p == nil || p[r.sym] <= 0 {
			skipped["no price for the symbol in its snapshot"]++
			continue
		}
		did := r.id
		zero := 0.0
		events = append(events, event{ts: r.ts, id: r.id, agentID: r.agentID, book: store.FillBook{PortfolioID: r.portfolioID},
			decisionID: &did, symbol: r.sym, side: r.action, qty: r.qty, price: p[r.sym], gasUSD: &zero})
	}

	sort.SliceStable(events, func(i, j int) bool {
		if !events[i].ts.Equal(events[j].ts) {
			return events[i].ts.Before(events[j].ts)
		}
		return events[i].id < events[j].id
	})

	written := 0
	for _, ev := range events {
		latest, lerr := st.LatestFillTS(ctx, ev.book, ev.symbol)
		if lerr != nil {
			log.Fatalf("latest fill: %v", lerr)
		}
		if latest != nil && !ev.ts.After(*latest) {
			skipped["older than a fill already in the ledger"]++
			continue
		}
		held, herr := heldBefore(ctx, pool, ev)
		if herr != nil {
			log.Fatalf("held before: %v", herr)
		}
		ev.heldBefore = held
		if *dry {
			fmt.Printf("%s %s %s %.8f %s at %.6f held_before %.8f\n", ev.ts.UTC().Format(time.RFC3339), bookName(ev.book), ev.side, ev.qty, ev.symbol, ev.price, ev.heldBefore)
			written++
			continue
		}
		if err := st.RecordFill(ctx, store.FillInsert{
			TS: ev.ts, AgentID: ev.agentID, Book: ev.book, DecisionID: ev.decisionID, ExecutionID: ev.execID,
			Symbol: ev.symbol, Side: ev.side, Quantity: ev.qty, Price: ev.price,
			GasUSD: ev.gasUSD, PoolFeeUSD: ev.poolFeeUSD, Source: "reconstructed", HeldBefore: ev.heldBefore,
		}); err != nil {
			log.Fatalf("record %s %s at %s: %v", ev.side, ev.symbol, ev.ts, err)
		}
		written++
	}

	log.Printf("fills: %d candidate(s), %d %s", len(events), written, map[bool]string{true: "would be recorded (dry run)", false: "recorded"}[*dry])
	for why, n := range skipped {
		log.Printf("  skipped %d: %s", n, why)
	}
}

// heldBefore reads what the book held of the symbol in the snapshot recorded
// strictly before the fill.
func heldBefore(ctx context.Context, pool *pgxpool.Pool, ev event) (float64, error) {
	var holdings map[string]any
	var err error
	if ev.book.SubscriptionID != "" {
		err = pool.QueryRow(ctx, `SELECT holdings FROM subscription_snapshots
			WHERE subscription_id = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1`, ev.book.SubscriptionID, ev.ts).Scan(&holdings)
	} else {
		err = pool.QueryRow(ctx, `SELECT holdings FROM portfolio_snapshots
			WHERE portfolio_id = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1`, ev.book.PortfolioID, ev.ts).Scan(&holdings)
	}
	if err != nil {
		// No earlier snapshot: the book started empty.
		return 0, nil
	}
	switch v := holdings[ev.symbol].(type) {
	case float64:
		return v, nil
	case string:
		var f float64
		_, _ = fmt.Sscanf(v, "%g", &f)
		return f, nil
	}
	return 0, nil
}

func units(v *big.Int, decimals int) float64 {
	if v == nil {
		return 0
	}
	f := new(big.Float).SetInt(v)
	f.Quo(f, new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)))
	out, _ := f.Float64()
	return out
}

func bookName(b store.FillBook) string {
	if b.SubscriptionID != "" {
		return "subscription:" + b.SubscriptionID[:8]
	}
	return "portfolio:" + b.PortfolioID[:8]
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}
