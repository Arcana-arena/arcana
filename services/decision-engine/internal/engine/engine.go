package engine

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
)

// Engine orchestrates one decision-execute cycle for an agent in a season.
type Engine struct {
	store *store.Store
	md    *marketdata.Client

	// deterministic is always present: it is the reference the LLM is measured
	// against, and it still runs every agent whose strategy_type names one of
	// the three built-in strategies.
	deterministic Decider
	// llmDecider is nil when no provider is configured. Nil means an LLM agent
	// REFUSES, loudly and on the record — it never silently falls back to a
	// deterministic strategy, because an agent that quietly stops being what it
	// says it is is the worst outcome available here.
	llmDecider Decider

	// broker is nil unless chain execution is configured. Nil is not a
	// degraded mode: it is the mode every agent ran in before phase 8, and an
	// agent with no wallet stays in it regardless. What must never happen is
	// an agent WITH a wallet settling against snapshot prices in memory while
	// its funds sit untouched on chain, so that combination refuses instead.
	broker *execution.Broker
}

// WithBroker attaches chain execution. Called at boot when a signer, an RPC
// and an allowlist are all configured; left alone when any of them is missing.
func (e *Engine) WithBroker(b *execution.Broker) *Engine {
	e.broker = b
	return e
}

func New(st *store.Store, md *marketdata.Client) *Engine {
	return &Engine{store: st, md: md, deterministic: NewDeterministicDecider()}
}

// WithLLM attaches an LLM decider. Called at boot when a provider is
// configured; left alone when one is not.
func (e *Engine) WithLLM(d Decider) *Engine {
	e.llmDecider = d
	return e
}

// HasBroker reports whether chain execution is attached. The HTTP layer asks
// because a chain-backed cycle waits for receipts and needs a deadline that
// reflects it.
func (e *Engine) HasBroker() bool { return e.broker != nil }

// deciderFor picks who decides this tick.
//
// The selection is on agents.strategy_type, the column that already decided
// this. 'llm' routes to the model; the three built-ins route to the functions
// that have always served them.
//
// When strategy_type is 'llm' and no provider is configured, this returns nil
// and the caller records a hold with llm_unavailable. It does NOT fall back.
// A configuration gap must not change what an agent is.
func (e *Engine) deciderFor(strategyType string) Decider {
	if strategyType == "llm" {
		return e.llmDecider
	}
	return e.deterministic
}

// Execute runs the automated pipeline and returns the recorded decision id.
//
// V1 pipeline (architecture.md §9):
//  1. Verify agent (must be active).
//  2. Load season ruleset; get-or-create the virtual portfolio.
//  3. Fetch the immutable market snapshot for this tick, plus the previous one
//     so a strategy can see which way prices moved.
//  4. Run the agent's declared strategy (agents.strategy_type) under its own
//     risk limits (agents.risk_profile) -> decision.
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

	// Previous tick's prices give the strategy a direction to react to. Its
	// absence (first tick of a season) is normal, and every strategy handles a
	// nil prev by standing still rather than guessing.
	var prevPrices map[string]float64
	prevSnap, err := e.md.GetPreviousSnapshot(ctx, req.MarketSnapshotRef)
	if err != nil {
		return 0, fmt.Errorf("previous snapshot: %w", err)
	}
	if prevSnap != nil {
		prevPrices = map[string]float64{}
		for _, q := range prevSnap.Symbols {
			prevPrices[q.Symbol] = q.Price
		}
	}

	// NAV before acting: the risk limits are all expressed against it.
	nav := cash
	for sym, q := range holdings {
		if price, ok := prices[sym]; ok {
			nav += toFloat(q) * price
		}
	}

	// WHICH SETTLEMENT LAYER, decided before anything else asks a question that
	// depends on it. The presence of a wallet row is the whole test; there is no
	// flag, so no configuration exists under which an agent holds funds on chain
	// and has its portfolio computed from arithmetic.
	wallet, werr := e.store.ChainWalletFor(ctx, req.AgentID)
	if werr != nil {
		return 0, werr
	}

	limits := riskLimitsFrom(agent.RiskProfile)
	if wallet != nil {
		// Tokens divide to eighteen decimals; the recorded quantity holds eight.
		// The default hundredth-of-a-share step is a convention from simulated
		// equities, and on a small real book it forbids every purchase of an
		// expensive symbol without saying so.
		limits.QtyStep = OnChainQtyStep
	}

	view := marketView{symbols: snap.Symbols, prices: prices, prev: prevPrices}
	in := DeciderInput{
		AgentID:  req.AgentID,
		Mandate:  agent.Mandate,
		Strategy: agent.StrategyType,
		View:     view,
		Holdings: holdings,
		Cash:     cash,
		NAV:      nav,
		Limits:   limits,
	}

	var intent tradeIntent
	var ev Evidence
	d := e.deciderFor(agent.StrategyType)
	if d == nil {
		// An LLM agent with no provider configured. It holds, on the record,
		// with the reason named — rather than trading as something it is not.
		intent = hold("no LLM provider is configured; this agent cannot decide")
		ev = Evidence{Decider: "llm", ReasonCode: ReasonLLMUnavailable}
	} else {
		var derr error
		intent, ev, derr = d.Decide(ctx, in)
		if derr != nil {
			return 0, fmt.Errorf("decide: %w", derr)
		}
	}

	var action, symbol, rationale string
	var qty *float64
	var execID *int64
	if wallet != nil {
		if e.broker == nil {
			return 0, fmt.Errorf(
				"agent %s holds a wallet at %s but chain execution is not configured; refusing to "+
					"settle its decision against snapshot prices while its funds sit on chain",
				req.AgentID, wallet.Address)
		}
		var cerr error
		action, symbol, qty, holdings, cash, rationale, execID, ev, cerr =
			e.settleOnChain(ctx, req, portfolio.ID, wallet, intent, prices, holdings, cash, ev)
		if cerr != nil {
			return 0, cerr
		}
	} else {
		action, symbol, qty, holdings, cash, rationale = applyIntent(intent, prices, holdings, cash)
	}

	decisionID, err := e.persist(ctx, req, portfolio.ID, action, symbol, qty, holdings, cash, prices, rationale)
	if err != nil {
		return 0, err
	}
	if execID != nil {
		if err := e.store.LinkExecutionToDecision(ctx, *execID, decisionID); err != nil {
			log.Printf("ERROR execution %d recorded but not linked to decision %d: %v", *execID, decisionID, err)
		}
	}

	// Evidence is attached after the decision exists. A failure here loses the
	// EXPLANATION, which is bad and is logged; failing the tick over it would
	// lose the DECISION, which would put a hole in an append-only record whose
	// whole value is that it has none.
	if err := e.store.AttachEvidence(ctx, decisionID, req.AgentID, req.Timestamp, toStoreEvidence(ev)); err != nil {
		log.Printf("ERROR decision %d recorded but its evidence was not: %v", decisionID, err)
	}
	return decisionID, nil
}

// toStoreEvidence converts the engine's evidence into its storage shape.
func toStoreEvidence(ev Evidence) store.DecisionEvidence {
	return store.DecisionEvidence{
		Decider:      ev.Decider,
		Provider:     ev.Provider,
		Model:        ev.Model,
		ModelVersion: ev.ModelVersion,
		Params:       ev.Params,
		PromptBody:   ev.PromptBody,
		ResponseBody: ev.ResponseBody,
		ReasonCode:   ev.ReasonCode,
		Thesis:       ev.Thesis,
	}
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
	if err := e.store.AttachEvidence(ctx, decisionID, req.AgentID, req.Timestamp,
		store.DecisionEvidence{Decider: "human"}); err != nil {
		log.Printf("ERROR decision %d recorded but its evidence was not: %v", decisionID, err)
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

// moneyPtr formats a traded QUANTITY for decisions.quantity.
//
// It used to write "%.2f", which is right for whole shares of a US equity and
// wrong for anything fractional. A chain-backed agent sold 0.00614483287630944
// AAPL and the row said 0.01 — a number that is not what the model asked for,
// not what the chain filled, and larger than the agent's entire holding. The
// column is numeric(20,8) and always was; only the writer was rounding.
//
// Eight decimals, matching the column. Beyond that the value would be silently
// truncated by Postgres, and a quantity that does not match the execution row
// is the whole failure this path exists to prevent.
func moneyPtr(v *float64) *string {
	if v == nil {
		return nil
	}
	s := strconv.FormatFloat(*v, 'f', 8, 64)
	return &s
}
