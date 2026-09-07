package engine

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
)

// Engine orchestrates one decision-execute cycle for an agent in a season.
type Engine struct {
	store *store.Store
	md    *marketdata.Client
}

func New(st *store.Store, md *marketdata.Client) *Engine {
	return &Engine{store: st, md: md}
}

// Execute runs the pipeline and returns the recorded decision id.
//
// V1 pipeline (architecture.md §9):
//  1. Verify agent (must be active).
//  2. Load season ruleset; get-or-create the virtual portfolio.
//  3. Fetch the immutable market snapshot for this tick.
//  4. Run a simple strategy -> decision (buy first symbol when idle, else hold).
//  5. Mark portfolio to market; append decision; persist snapshot.
func (e *Engine) Execute(ctx context.Context, req ExecuteRequest) (int64, error) {
	if req.Timestamp.IsZero() {
		req.Timestamp = time.Now().UTC()
	}
	if req.MarketSnapshotRef == "" {
		return 0, fmt.Errorf("market_snapshot_ref is required")
	}

	agent, err := e.store.GetActiveAgent(ctx, req.AgentID)
	if err != nil {
		return 0, err
	}
	_ = agent

	ruleset, err := e.store.GetSeasonRuleset(ctx, req.SeasonID)
	if err != nil {
		return 0, err
	}

	initialCapital := "100000.00"
	if v, ok := ruleset["initial_capital"]; ok {
		switch n := v.(type) {
		case float64:
			initialCapital = fmt.Sprintf("%.2f", n)
		case string:
			initialCapital = n
		}
	}

	portfolio, err := e.store.GetOrCreatePortfolio(ctx, req.AgentID, req.SeasonID, initialCapital)
	if err != nil {
		return 0, fmt.Errorf("portfolio: %w", err)
	}

	// 3. Fetch the market snapshot this agent must decide against (fairness).
	snap, err := e.md.GetSnapshot(ctx, req.MarketSnapshotRef)
	if err != nil {
		return 0, fmt.Errorf("market snapshot: %w", err)
	}
	prices := map[string]float64{}
	for _, q := range snap.Symbols {
		prices[q.Symbol] = q.Price
	}

	// 4. Strategy: when idle (no holdings) and cash available, buy the first
	//    symbol with ~50% of cash; otherwise hold.
	cash := parseMoney(portfolio.Cash)
	holdings := portfolio.Holdings // symbol -> qty (float64 in JSON)

	action := "hold"
	rationale := "holding existing position"
	symbol := ""
	var qty *float64

	if len(holdings) == 0 && cash > 0 && len(snap.Symbols) > 0 {
		first := snap.Symbols[0]
		if first.Price > 0 {
			budget := cash * 0.5
			buyQty := math.Floor(budget/first.Price*100) / 100 // 2 decimals
			if buyQty >= 1 {
				action = "buy"
				symbol = first.Symbol
				qty = &buyQty
				cash -= buyQty * first.Price
				holdings = cloneHoldings(holdings)
				holdings[first.Symbol] = qtyFromHoldings(holdings, first.Symbol) + buyQty
				rationale = fmt.Sprintf("buy %s x %.2f (diversify into first symbol)", symbol, buyQty)
			}
		}
	}

	// 5. Mark to market: NAV = cash + sum(qty * price).
	nav := cash
	for sym, q := range holdings {
		if price, ok := prices[sym]; ok {
			nav += toFloat(q) * price
		}
	}

	// Persist decision.
	decisionID, err := e.store.AppendDecision(ctx, store.DecisionInsert{
		AgentID:            req.AgentID,
		SeasonID:           req.SeasonID,
		TS:                 req.Timestamp,
		MarketSnapshotRef:  req.MarketSnapshotRef,
		Action:             action,
		Symbol:             symbol,
		Quantity:           moneyPtr(qty),
		ResultingAllocation: holdings,
		Rationale:           rationale,
	})
	if err != nil {
		return 0, err
	}

	// Persist portfolio snapshot (mark-to-market NAV).
	if err := e.store.WriteSnapshot(ctx, portfolio.ID, req.Timestamp, holdings, fmt.Sprintf("%.2f", nav), fmt.Sprintf("%.2f", cash)); err != nil {
		return 0, err
	}

	return decisionID, nil
}

// --- numeric helpers (V1; move to decimal lib when precision matters) ---

func parseMoney(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

func cloneHoldings(h map[string]any) map[string]any {
	out := make(map[string]any, len(h))
	for k, v := range h {
		out[k] = v
	}
	return out
}

func qtyFromHoldings(h map[string]any, sym string) float64 {
	if v, ok := h[sym]; ok {
		return toFloat(v)
	}
	return 0
}

func moneyPtr(v *float64) *string {
	if v == nil {
		return nil
	}
	s := fmt.Sprintf("%.2f", *v)
	return &s
}
