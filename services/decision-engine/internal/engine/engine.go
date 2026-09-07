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

// Execute runs the automated pipeline and returns the recorded decision id.
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
	if agent.StrategyType == "human" {
		return 0, fmt.Errorf("agent %s is a human-managed agent; use the manual decision endpoint", req.AgentID)
	}

	portfolio, snap, prices, err := e.loadState(ctx, req.AgentID, req.SeasonID, req.MarketSnapshotRef)
	if err != nil {
		return 0, err
	}

	cash := parseMoney(portfolio.Cash)
	holdings := portfolio.Holdings

	// Strategy: when idle (no holdings) and cash available, buy the first symbol
	// with ~50% of cash; otherwise hold.
	action := "hold"
	rationale := "holding existing position"
	symbol := ""
	var qty *float64

	if len(holdings) == 0 && cash > 0 && len(snap.Symbols) > 0 {
		first := snap.Symbols[0]
		if first.Price > 0 {
			buyQty := math.Floor(cash*0.5/first.Price*100) / 100
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

	decisionID, err := e.persist(ctx, req, portfolio.ID, action, symbol, qty, holdings, cash, prices, rationale)
	if err != nil {
		return 0, err
	}
	return decisionID, nil
}

// ExecuteManual records a human-submitted trade for a human_vs_ai session.
// Only agents with strategy_type='human' can use this endpoint. Execution price
// comes from the immutable market snapshot (identical conditions for everyone).
func (e *Engine) ExecuteManual(ctx context.Context, req ExecuteManualRequest) (int64, error) {
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
	if agent.StrategyType != "human" {
		return 0, fmt.Errorf("agent %s is not human-managed; manual decisions are not allowed", req.AgentID)
	}

	// Turn gating: a human may only submit while their competition tick is open
	// and they must act on that tick's immutable snapshot.
	tick, err := e.store.OpenTickForAgent(ctx, req.AgentID)
	if err != nil {
		return 0, err
	}
	if tick == nil {
		return 0, fmt.Errorf("no open tick for agent %s; submit only during an open decision round", req.AgentID)
	}
	if tick.MarketSnapshotRef != req.MarketSnapshotRef {
		return 0, fmt.Errorf("snapshot mismatch: open tick expects %s, got %s", tick.MarketSnapshotRef, req.MarketSnapshotRef)
	}

	portfolio, _, prices, err := e.loadState(ctx, req.AgentID, req.SeasonID, req.MarketSnapshotRef)
	if err != nil {
		return 0, err
	}

	cash := parseMoney(portfolio.Cash)
	holdings := cloneHoldings(portfolio.Holdings)

	action := req.Trade.Action
	symbol := req.Trade.Symbol
	qty := req.Trade.Quantity
	rationale := fmt.Sprintf("human decision: %s %s x %.2f", action, symbol, qty)

	switch action {
	case "hold":
		// no change
	case "buy":
		price, ok := prices[symbol]
		if !ok {
			return 0, fmt.Errorf("symbol %s not in snapshot %s", symbol, req.MarketSnapshotRef)
		}
		cost := qty * price
		if cost > cash {
			return 0, fmt.Errorf("insufficient cash: need %.2f have %.2f", cost, cash)
		}
		cash -= cost
		holdings[symbol] = qtyFromHoldings(holdings, symbol) + qty
	case "sell":
		price, ok := prices[symbol]
		if !ok {
			return 0, fmt.Errorf("symbol %s not in snapshot %s", symbol, req.MarketSnapshotRef)
		}
		have := qtyFromHoldings(holdings, symbol)
		if qty > have {
			return 0, fmt.Errorf("insufficient holdings: have %.2f want to sell %.2f", have, qty)
		}
		cash += qty * price
		remaining := have - qty
		if remaining <= 1e-9 {
			delete(holdings, symbol)
		} else {
			holdings[symbol] = remaining
		}
	default:
		return 0, fmt.Errorf("unsupported action %q (want buy|sell|hold)", action)
	}

	decisionID, err := e.persist(ctx, ExecuteRequest{
		AgentID:           req.AgentID,
		SeasonID:          req.SeasonID,
		Timestamp:         req.Timestamp,
		MarketSnapshotRef: req.MarketSnapshotRef,
	}, portfolio.ID, action, symbol, &qty, holdings, cash, prices, rationale)
	if err != nil {
		return 0, err
	}
	return decisionID, nil
}

// --- shared pipeline pieces ---

// loadState resolves portfolio + market snapshot + price map for an agent/season.
func (e *Engine) loadState(ctx context.Context, agentID, seasonID, ref string) (*store.PortfolioRow, *marketdata.Snapshot, map[string]float64, error) {
	ruleset, err := e.store.GetSeasonRuleset(ctx, seasonID)
	if err != nil {
		return nil, nil, nil, err
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

	portfolio, err := e.store.GetOrCreatePortfolio(ctx, agentID, seasonID, initialCapital)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("portfolio: %w", err)
	}

	snap, err := e.md.GetSnapshot(ctx, ref)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("market snapshot: %w", err)
	}
	prices := map[string]float64{}
	for _, q := range snap.Symbols {
		prices[q.Symbol] = q.Price
	}
	return portfolio, snap, prices, nil
}

// persist appends the decision + portfolio snapshot, computing NAV by mark-to-market.
func (e *Engine) persist(ctx context.Context, req ExecuteRequest, portfolioID, action, symbol string, qty *float64, holdings map[string]any, cash float64, prices map[string]float64, rationale string) (int64, error) {
	nav := cash
	for sym, q := range holdings {
		if price, ok := prices[sym]; ok {
			nav += toFloat(q) * price
		}
	}

	decisionID, err := e.store.AppendDecision(ctx, store.DecisionInsert{
		AgentID:             req.AgentID,
		SeasonID:            req.SeasonID,
		TS:                  req.Timestamp,
		MarketSnapshotRef:   req.MarketSnapshotRef,
		Action:              action,
		Symbol:              symbol,
		Quantity:            moneyPtr(qty),
		ResultingAllocation: holdings,
		Rationale:           rationale,
	})
	if err != nil {
		return 0, err
	}

	if err := e.store.WriteSnapshot(ctx, portfolioID, req.Timestamp, holdings, fmt.Sprintf("%.2f", nav), fmt.Sprintf("%.2f", cash)); err != nil {
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
