package engine

import (
	"context"
	"errors"
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

	// tokenBudget caps what ONE AGENT may spend on inference per UTC day.
	// Zero is unmetered, which is what every deployment had until now.
	tokenBudget int64

	// cost holds the SHAPE of the transaction cost meter -- how big a sample it
	// needs, how far back it looks. The percentage itself is never stored here:
	// it belongs to each agent risk_profile, so there is no field on this struct
	// a deployment could set to impose one on everybody.
	cost costMeter
}

// WithTokenBudget sets the per-agent daily inference cap.
//
// It is the guard that replaces the cadence floor. The floor limited how often
// an agent could think in order to limit what it could spend; this limits the
// spending, which is the thing that was actually meant.
func (e *Engine) WithTokenBudget(tokens int64) *Engine {
	e.tokenBudget = tokens
	return e
}

// WithBroker attaches chain execution. Called at boot when a signer, an RPC
// and an allowlist are all configured; left alone when any of them is missing.
func (e *Engine) WithBroker(b *execution.Broker) *Engine {
	e.broker = b
	return e
}

func New(st *store.Store, md *marketdata.Client) *Engine {
	// defaultCostMeter(0) is the meter UNMETERED: the sample rules are set, the
	// budget is not. Each agent supplies its own or has none.
	return &Engine{store: st, md: md, deterministic: NewDeterministicDecider(), cost: defaultCostMeter(0)}
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

	// A VERIFICATION MAY NOT SPEND. Checked before the agent is even loaded, so
	// there is no path where a suite gets far enough to broadcast anything.
	if verr := e.refuseIfVerificationWouldSpend(ctx, req.IsVerification, req.AgentID); verr != nil {
		return 0, verr
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

	// THE MOVE THIS AGENT HAS NOT SEEN YET, which is the prices it last decided
	// against — not the snapshot immediately before this one.
	//
	// The difference did not exist while one four-hourly tick made every agent
	// decide together: the snapshot before yours WAS the one from your last
	// decision. Per-agent cadence broke that on 2026-09-20. Snapshots are taken
	// whenever any agent is due, so the global previous can be sixty seconds
	// old, and an agent on a four-hour cadence was asked whether anything had
	// moved 0.3% in the last minute. Nothing ever had. Every agent held, on
	// every run, and its record said only "no symbol moved beyond the rebalance
	// band" — true, and about a window nobody chose.
	//
	// SOURCE MUST MATCH, and this is not defensive noise: a ref left over from
	// the Polygon vendor path describes a different market from the pool, and
	// comparing across them would invent a return out of the gap between two
	// price sources. Mismatched, or unreadable, falls back to the global
	// previous — the old behaviour, which is wrong by a different amount but
	// never wrong about WHICH market.
	//
	// Its absence (this agent's first decision of the season) is normal, and
	// every strategy handles a nil prev by standing still rather than guessing —
	// except that materialMove() reads nil as "there is a book to open" and lets
	// the first decision through.
	var prevPrices map[string]float64
	var prevSnap *marketdata.Snapshot
	if ownRef, oerr := e.store.LastDecisionSnapshotRef(ctx, req.AgentID, req.SeasonID); oerr != nil {
		log.Printf("agent %s: could not read its last decision's snapshot (%v); comparing against "+
			"the previous snapshot instead, which may be a shorter window than its cadence", req.AgentID, oerr)
	} else if ownRef != "" && ownRef != req.MarketSnapshotRef {
		own, serr := e.md.GetSnapshot(ctx, ownRef)
		switch {
		case serr != nil:
			log.Printf("agent %s: its last snapshot %s is unreadable (%v); comparing against the "+
				"previous snapshot instead", req.AgentID, ownRef, serr)
		case own != nil && own.Source != snap.Source:
			log.Printf("agent %s: its last snapshot %s came from %s and this one from %s; comparing "+
				"across two price sources would invent a return, so the previous snapshot is used",
				req.AgentID, ownRef, own.Source, snap.Source)
		default:
			prevSnap = own
		}
	}
	if prevSnap == nil {
		var perr error
		prevSnap, perr = e.md.GetPreviousSnapshot(ctx, req.MarketSnapshotRef)
		if perr != nil {
			return 0, fmt.Errorf("previous snapshot: %w", perr)
		}
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

	// What this agent has already spent on the model today. Read once, before
	// the decider is asked anything, so the meter is checked against the record
	// rather than against a number this process happens to remember.
	//
	// A failure to read it does NOT become a free pass. An unreadable meter is
	// treated as exhausted, for the same reason an unreadable blocklist is
	// treated as refusing: could not check is not the same as fine.
	var usedToday int64
	if e.tokenBudget > 0 {
		u, uerr := e.store.TokensUsedToday(ctx, req.AgentID)
		if uerr != nil {
			log.Printf("agent %s: inference meter unreadable, treating the budget as spent: %v", req.AgentID, uerr)
			usedToday = e.tokenBudget
		} else {
			usedToday = u
		}
	}

	view := marketView{symbols: snap.Symbols, prices: prices, prev: prevPrices}

	// What each pool will accept, for the prompt. Empty without a broker, which
	// is the paper path: there is no pool, so there is no round trip to state.
	minGuard := map[string]float64{}
	if e.broker != nil {
		for _, q := range snap.Symbols {
			if fee := e.broker.PoolFeeOf(q.Symbol); fee > 0 {
				minGuard[q.Symbol] = roundTripPct(fee)
			}
		}
	}

	in := DeciderInput{
		AgentID:  req.AgentID,
		Mandate:  agent.Mandate,
		Strategy: agent.StrategyType,
		View:     view,
		Holdings: holdings,
		Cash:     cash,
		NAV:      nav,
		Limits:   limits,

		MinGuardPct: minGuard,

		TokensUsedToday: usedToday,
		TokenBudget:     e.tokenBudget,
	}

	// THE TRANSACTION COST METER, checked before the agent is asked anything.
	//
	// Before the decider, not after: an agent over its budget must not buy
	// inference either, and a paused agent that still pays a model every tick
	// is only half stopped.
	//
	// It produces a RECORDED HOLD with a reason, never silence. An agent that
	// has gone quiet and an agent that has been stopped for spending look
	// identical from outside unless the record says which.
	cv := e.checkCost(ctx, req.AgentID, limits.CostBudgetMonthlyPct)
	logCostVerdict(req.AgentID, cv)

	var intent tradeIntent
	var ev Evidence
	d := e.deciderFor(agent.StrategyType)

	switch {
	case cv.pause:
		// A PAUSED AGENT FLOWS THROUGH THE NORMAL PATH. It is a hold, and the
		// rest of this function already knows how to record one — including
		// reading a chain-backed agent's real position, which is still worth
		// recording while it is stood down. A separate path here would be a
		// second copy of the persistence logic, and the two would drift.
		intent = hold("cost budget exceeded: " + cv.detail)
		ev = Evidence{ReasonCode: ReasonCostBudget}
		if d != nil {
			ev.Decider = d.Name()
		}

	case d == nil:
		// An LLM agent with no provider configured. It holds, on the record,
		// with the reason named — rather than trading as something it is not.
		intent = hold("no LLM provider is configured; this agent cannot decide")
		ev = Evidence{Decider: "llm", ReasonCode: ReasonLLMUnavailable}

	default:
		var derr error
		intent, ev, derr = d.Decide(ctx, in)
		if derr != nil {
			return 0, fmt.Errorf("decide: %w", derr)
		}
	}

	var action, symbol, rationale string
	var qty *float64
	var execID *int64
	var set settlement
	// What the virtual book held of the traded symbol BEFORE the fill, for the
	// fill ledger's reconciliation. The chain path reads its own.
	virtualHeld := HeldQty(holdings, intent.Symbol)
	if wallet != nil {
		if e.broker == nil {
			return 0, fmt.Errorf(
				"agent %s holds a wallet at %s but chain execution is not configured; refusing to "+
					"settle its decision against snapshot prices while its funds sit on chain",
				req.AgentID, wallet.Address)
		}

		// THE LEASE. Between here and the end of settlement this agent's funds
		// belong to this cycle, so a protective exit crossing a level in the
		// same second cannot also build a sell of the same position.
		//
		// NOBODY WAITS. If the guard already holds it, this tick becomes a
		// recorded hold and says who has it. Queuing would produce exactly the
		// thing being prevented: two transactions from one intent, a second
		// apart, the second one discovering the position is gone.
		//
		// Taken here rather than at the top of the function because a virtual
		// agent has no funds to contend over, and because a tick that is not
		// going to touch the chain should not be able to block one that is.
		lerr := e.store.AcquireLease(ctx, req.AgentID, leaseHolderCycle, LeaseTTL,
			"decision cycle "+req.MarketSnapshotRef)
		if errors.Is(lerr, store.ErrLeaseHeld) {
			who, until, _, _ := e.store.LeaseHolder(ctx, req.AgentID)
			intent = hold(fmt.Sprintf(
				"stood down: %s is moving this agent's funds right now (lease held until %s). "+
					"One intent must not become two transactions, so this tick records a hold "+
					"rather than queueing behind it",
				who, until.UTC().Format(time.RFC3339)))
			ev.ReasonCode = ReasonPositionLocked
		} else if lerr != nil {
			// UNREADABLE LEASE PAUSES. Not knowing whether somebody else is
			// mid-swap is not the same as knowing nobody is.
			intent = hold("stood down: the execution lease could not be read (" + lerr.Error() +
				"), so whether another actor is moving these funds is unknown")
			ev.ReasonCode = ReasonPositionLocked
		} else {
			defer func() {
				if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), req.AgentID, leaseHolderCycle); rerr != nil {
					log.Printf("agent %s: lease not released early, it will expire: %v", req.AgentID, rerr)
				}
			}()
		}

		var cerr error
		set, cerr = e.settleOnChain(ctx, req, portfolio.ID, wallet, intent, prices, holdings, cash, ev)
		if cerr != nil {
			return 0, cerr
		}
		action, symbol, qty, holdings, cash, rationale, execID, ev =
			set.Action, set.Symbol, set.Qty, set.Holdings, set.Cash, set.Rationale, set.ExecID, set.Ev
	} else {
		action, symbol, qty, holdings, cash, rationale = applyIntent(intent, prices, holdings, cash)
	}

	// THE EVIDENCE GOES IN WITH THE DECISION. It used to be attached at the very
	// end of this function, after execution linking and every subscriber trade,
	// by an UPDATE that was allowed to fail. The commitment (0047) has to be
	// written when the decision is recorded, not afterwards, so the evidence and
	// its seal are part of the insert now.
	decisionID, err := e.persist(ctx, req, portfolio.ID, action, symbol, qty, holdings, cash, prices, rationale, ev)
	if err != nil {
		return 0, err
	}
	if execID != nil {
		if err := e.store.LinkExecutionToDecision(ctx, *execID, decisionID); err != nil {
			log.Printf("ERROR execution %d recorded but not linked to decision %d: %v", *execID, decisionID, err)
		}
	}

	// THE FILL, with its price and its effect on the position (0051). Every
	// position gets a cost basis here, whether or not a guard is armed on it.
	if wallet != nil {
		e.writeFill(ctx, req.AgentID, store.FillBook{PortfolioID: portfolio.ID}, &decisionID, execID,
			req.Timestamp, "on_chain", set.Fill)
	} else {
		e.writeFill(ctx, req.AgentID, store.FillBook{PortfolioID: portfolio.ID}, &decisionID, nil,
			req.Timestamp, "simulated", virtualFill(action, symbol, qty, prices, virtualHeld))
	}

	// Protective levels are armed AFTER the decision exists, so the guard row
	// can name the decision that opened the position. A failure here loses the
	// protection and must be loud; failing the tick would lose the trade that
	// has already happened on chain.
	e.applyGuardChanges(ctx, req.AgentID, nil, &decisionID, set)

	// AND THE SAME DECISION, IN EVERY SUBSCRIBER'S WALLET.
	//
	// After the decision is persisted, so each execution can name the decision
	// it came from; after the creator's leg, so a subscriber never delays it.
	// Failures are per wallet and never reach here — a buyer out of gas is that
	// buyer's outcome, not the tick's.
	//
	// The INTENT is passed, not the creator's executed quantity: the creator
	// chose a direction, and each wallet sizes it against its own capital under
	// its own limits.
	if wallet != nil {
		e.tradeForSubscribers(ctx, req, decisionID, intent, prices)
	}

	return decisionID, nil
}

// toStoreEvidence converts the engine's evidence into its storage shape.
func toStoreEvidence(ev Evidence) store.DecisionEvidence {
	return store.DecisionEvidence{
		Decider:          ev.Decider,
		Provider:         ev.Provider,
		Model:            ev.Model,
		ModelVersion:     ev.ModelVersion,
		Params:           ev.Params,
		PromptBody:       ev.PromptBody,
		ResponseBody:     ev.ResponseBody,
		SystemPromptBody: ev.SystemPromptBody,
		ReasonCode:       ev.ReasonCode,
		Thesis:           ev.Thesis,

		PromptTokens:     ev.PromptTokens,
		CompletionTokens: ev.CompletionTokens,
		CachedTokens:     ev.CachedTokens,
		LatencyMS:        ev.LatencyMS,
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
	heldBefore := HeldQty(holdings, symbol)

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
		holdings[symbol] = HeldQty(holdings, symbol) + qty
	case "sell":
		price, ok := prices[symbol]
		if !ok {
			return 0, fmt.Errorf("symbol %s not in snapshot %s", symbol, req.MarketSnapshotRef)
		}
		have := HeldQty(holdings, symbol)
		if qty > have {
			return 0, fmt.Errorf("insufficient holdings: have %.8f want to sell %.8f", have, qty)
		}
		cash += qty * price
		remaining := have - qty
		if remaining < DustFloor {
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
	}, portfolio.ID, action, symbol, &qty, holdings, cash, prices, rationale, Evidence{Decider: "human"})
	if err != nil {
		return 0, err
	}
	e.writeFill(ctx, req.AgentID, store.FillBook{PortfolioID: portfolio.ID}, &decisionID, nil,
		req.Timestamp, "simulated", virtualFill(action, symbol, &qty, prices, heldBefore))
	return decisionID, nil
}

// appendDecision records a decision with its evidence and commitment in one
// transaction (store.AppendDecisionSealed).
//
// A DECISION IS NEVER LOST TO ITS SEAL. If the sealed write fails, the decision
// is recorded the way it was before commitments existed — row first, evidence
// attached after — and the missing commitment is logged as an error. The public
// record then shows a decision with no commitment, which is true, rather than a
// hole where a decision was, which would not be. Every writer of a decision row
// comes through here, so no path can quietly skip the seal.
func (e *Engine) appendDecision(ctx context.Context, d store.DecisionInsert, ev Evidence) (int64, error) {
	sev := toStoreEvidence(ev)
	id, _, err := e.store.AppendDecisionSealed(ctx, d, sev)
	if err == nil {
		return id, nil
	}
	log.Printf("ERROR agent %s: decision could not be sealed with a commitment; recording it without one: %v",
		d.AgentID, err)

	id, aerr := e.store.AppendDecision(ctx, d)
	if aerr != nil {
		return 0, aerr
	}
	if xerr := e.store.AttachEvidence(ctx, id, d.AgentID, d.TS, sev); xerr != nil {
		log.Printf("ERROR decision %d recorded but its evidence was not: %v", id, xerr)
	}
	return id, nil
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

// persist appends the decision — sealed with its evidence and commitment — and
// the portfolio snapshot, computing NAV by mark-to-market.
func (e *Engine) persist(ctx context.Context, req ExecuteRequest, portfolioID, action, symbol string, qty *float64, holdings map[string]any, cash float64, prices map[string]float64, rationale string, ev Evidence) (int64, error) {
	nav := cash
	for sym, q := range holdings {
		if price, ok := prices[sym]; ok {
			nav += toFloat(q) * price
		}
	}

	decisionID, err := e.appendDecision(ctx, store.DecisionInsert{
		AgentID:             req.AgentID,
		SeasonID:            req.SeasonID,
		TS:                  req.Timestamp,
		MarketSnapshotRef:   req.MarketSnapshotRef,
		Action:              action,
		Symbol:              symbol,
		Quantity:            moneyPtr(qty),
		ResultingAllocation: holdings,
		Rationale:           rationale,
	}, ev)
	if err != nil {
		return 0, err
	}

	// SEALED LIKE THE DECISION BESIDE IT. The NAV series is what a score is
	// computed from, so a score can only be recomputed from data nobody edited
	// if each snapshot is sealed when written. A snapshot is never lost to its
	// seal: if the sealed write fails it is recorded the way it was before seals
	// existed, and the missing seal is logged as an error.
	navS, cashS := fmt.Sprintf("%.2f", nav), fmt.Sprintf("%.2f", cash)
	if _, err := e.store.WriteSnapshotSealed(ctx, portfolioID, req.AgentID, req.SeasonID, req.Timestamp, holdings, navS, cashS); err != nil {
		log.Printf("ERROR agent %s: portfolio snapshot could not be sealed; recording it without a seal: %v", req.AgentID, err)
		if werr := e.store.WriteSnapshot(ctx, portfolioID, req.Timestamp.UTC().Truncate(time.Microsecond), holdings, navS, cashS); werr != nil {
			return 0, werr
		}
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
