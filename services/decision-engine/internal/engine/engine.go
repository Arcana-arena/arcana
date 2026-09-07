package engine

import (
	"context"
	"fmt"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

// Engine orchestrates one decision-execute cycle for an agent in a season.
type Engine struct {
	store *store.Store
}

func New(st *store.Store) *Engine {
	return &Engine{store: st}
}

// Execute runs the pipeline and returns the recorded decision id.
//
// V1 pipeline (per architecture.md §9):
//  1. Load & verify agent (must be active).
//  2. Load season ruleset; get-or-create the virtual portfolio.
//  3. Run the strategy to produce a decision (V1: deterministic stub -> hold).
//  4. Append the decision to the immutable decisions hypertable.
//  5. Persist a portfolio snapshot for this tick.
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
	_ = agent // stub strategy does not consume agent config yet

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

	// ---- V1 stub strategy: hold current allocation, no market prices yet. ----
	action := "hold"
	rationale := "v1 stub: no market data feed wired; decision recorded for verified history"
	allocation := portfolio.Holdings

	// 4. Append immutable decision.
	decisionID, err := e.store.AppendDecision(ctx, store.DecisionInsert{
		AgentID:            req.AgentID,
		SeasonID:           req.SeasonID,
		TS:                 req.Timestamp,
		MarketSnapshotRef:  req.MarketSnapshotRef,
		Action:             action,
		Symbol:             "",
		Quantity:           "",
		ResultingAllocation: allocation,
		Rationale:           rationale,
	})
	if err != nil {
		return 0, err
	}

	// 5. Portfolio snapshot for this tick. NAV unchanged (hold, no prices).
	if err := e.store.WriteSnapshot(ctx, portfolio.ID, req.Timestamp, allocation, portfolio.NAV, portfolio.Cash); err != nil {
		return 0, err
	}

	return decisionID, nil
}
