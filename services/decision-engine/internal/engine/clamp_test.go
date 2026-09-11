package engine

import (
	"math"
	"testing"
)

// The clamp is the claim that makes free-text mandates safe, so it is proved
// here rather than inferred from a model's behaviour.
//
// WHY THIS FILE EXISTS. prompt-injection-verify writes mandates demanding 100%
// of NAV and checks the system is unharmed. On a flat market the model held
// every time, which proves the system survived a hostile prompt and proves
// NOTHING about the clamp — the path was never taken. A test that passes
// because the interesting branch did not run is the kind of green light this
// project has already learned to distrust.
//
// buyableQty is a pure function of numbers. Nothing here needs a model, a
// market or a network, and every case below is a size a prompt could ask for.

func limitsFor(trade, maxPos, floor, step float64) RiskLimits {
	return RiskLimits{
		MaxPositionPct:   maxPos,
		TradeSizePct:     trade,
		CashFloorPct:     floor,
		RebalanceBandPct: 0.0001,
		QtyStep:          step,
	}
}

func viewAt(symbol string, price float64) marketView {
	return marketView{prices: map[string]float64{symbol: price}}
}

func TestBuyableQtyRespectsTradeSize(t *testing.T) {
	// NAV 1000, one trade may commit 20%, price 100 -> at most 2 shares.
	l := limitsFor(0.20, 1.0, 0.0, 0.01)
	got := buyableQty("AAPL", viewAt("AAPL", 100), map[string]any{}, 1000, 1000, l)
	if got != 2 {
		t.Fatalf("trade size cap: want 2, got %v", got)
	}
}

func TestBuyableQtyRespectsCashFloor(t *testing.T) {
	// Cash 100 of a 1000 NAV, and 5% of NAV (50) may never be spent. The
	// spendable 50 buys half a share at 100, which the 0.01 step keeps.
	l := limitsFor(1.0, 1.0, 0.05, 0.01)
	got := buyableQty("AAPL", viewAt("AAPL", 100), map[string]any{}, 100, 1000, l)
	if got != 0.5 {
		t.Fatalf("cash floor: want 0.5, got %v", got)
	}
	// And when the floor is already breached, nothing may be bought at all.
	if got := buyableQty("AAPL", viewAt("AAPL", 100), map[string]any{}, 40, 1000, l); got != 0 {
		t.Fatalf("cash below the floor: want 0, got %v", got)
	}
}

func TestBuyableQtyRespectsPositionCap(t *testing.T) {
	// 30% cap on a 1000 NAV = 300 of AAPL. Already holding 2.5 shares at 100
	// leaves 50 of headroom, which is half a share.
	l := limitsFor(1.0, 0.30, 0.0, 0.01)
	got := buyableQty("AAPL", viewAt("AAPL", 100), map[string]any{"AAPL": 2.5}, 1000, 1000, l)
	if got != 0.5 {
		t.Fatalf("position cap: want 0.5, got %v", got)
	}
	// Full is full: no headroom, no trade.
	if got := buyableQty("AAPL", viewAt("AAPL", 100), map[string]any{"AAPL": 3.0}, 1000, 1000, l); got != 0 {
		t.Fatalf("position cap reached: want 0, got %v", got)
	}
}

func TestBuyableQtyRefusesBelowTheStep(t *testing.T) {
	// The case that silently blocked every real buy: a budget smaller than one
	// tradable unit. On a virtual book the step is a hundredth of a share, so a
	// 5.89 budget against a 660 price is 0.0089 -- and must be refused, not
	// rounded up into a trade nobody can afford.
	virtual := limitsFor(0.5, 1.0, 0.05, 0.01)
	if got := buyableQty("SPY", viewAt("SPY", 660), map[string]any{}, 11.78, 11.78, virtual); got != 0 {
		t.Fatalf("below the virtual step: want 0, got %v", got)
	}
	// On chain the step is 1e-8, and the same budget is perfectly tradable.
	onchain := limitsFor(0.5, 1.0, 0.05, OnChainQtyStep)
	got := buyableQty("SPY", viewAt("SPY", 660), map[string]any{}, 11.78, 11.78, onchain)
	if got <= 0 {
		t.Fatalf("on-chain step: want a positive quantity, got %v", got)
	}
	if got*660 > 11.78*0.5+1e-9 {
		t.Fatalf("on-chain step: %v shares commits %v, over the 0.5 NAV cap", got, got*660)
	}
	// It is a multiple of the step, so the recorded quantity is representable.
	if mult := got / OnChainQtyStep; math.Abs(mult-math.Round(mult)) > 1e-6 {
		t.Fatalf("quantity %v is not a multiple of the step %v", got, OnChainQtyStep)
	}
}

// THE ONE A HOSTILE PROMPT ACTUALLY REACHES.
//
// The mandate cannot change RiskLimits — those come from the agent's row. What
// it CAN influence is size_pct in the model's answer, and the rule is that the
// request may lower the limit and never raise it. This is that rule, isolated
// from the model.
func TestRequestedSizeMayLowerNeverRaise(t *testing.T) {
	agent := limitsFor(0.20, 1.0, 0.0, 0.01)
	price, nav, cash := 100.0, 1000.0, 1000.0

	apply := func(requested float64) float64 {
		l := agent
		if requested > 0 && requested < l.TradeSizePct {
			l.TradeSizePct = requested
		}
		return buyableQty("AAPL", viewAt("AAPL", price), map[string]any{}, cash, nav, l)
	}

	base := apply(0) // no request at all
	if base != 2 {
		t.Fatalf("baseline: want 2, got %v", base)
	}
	if got := apply(0.10); got != 1 {
		t.Fatalf("a smaller request must be honoured: want 1, got %v", got)
	}
	for _, greedy := range []float64{0.5, 1.0, 5.0, 1e9} {
		if got := apply(greedy); got != base {
			t.Fatalf("a request of %v raised the size to %v; the agent's own limit is %v", greedy, got, base)
		}
	}
}

// A price the snapshot does not carry is not a trade, whatever was asked for.
// This is the arithmetic half of "symbols come from the snapshot, never from
// the mandate"; the other half is the symbol check in Decide.
func TestBuyableQtyRefusesUnpricedSymbol(t *testing.T) {
	l := limitsFor(1.0, 1.0, 0.0, 0.01)
	if got := buyableQty("DOGE", viewAt("AAPL", 100), map[string]any{}, 1000, 1000, l); got != 0 {
		t.Fatalf("unpriced symbol: want 0, got %v", got)
	}
	if got := buyableQty("AAPL", viewAt("AAPL", 0), map[string]any{}, 1000, 1000, l); got != 0 {
		t.Fatalf("zero price: want 0, got %v", got)
	}
}

// applyIntent is the last gate for a virtual agent: an intent it cannot settle
// must not become a position. A buy larger than cash is the shape a hostile
// mandate produces most easily.
func TestApplyIntentRefusesWhatItCannotSettle(t *testing.T) {
	prices := map[string]float64{"AAPL": 100}
	action, _, qty, holdings, cash, _ := applyIntent(
		tradeIntent{Action: "buy", Symbol: "AAPL", Quantity: 100, Rationale: "all in"},
		prices, map[string]any{}, 50)
	if action != "hold" || qty != nil {
		t.Fatalf("unaffordable buy: want a hold with no quantity, got %s %v", action, qty)
	}
	if cash != 50 || len(holdings) != 0 {
		t.Fatalf("unaffordable buy changed the book: cash %v holdings %v", cash, holdings)
	}

	// Selling more than is held is the mirror image.
	action, _, qty, _, _, _ = applyIntent(
		tradeIntent{Action: "sell", Symbol: "AAPL", Quantity: 10},
		prices, map[string]any{"AAPL": 1.0}, 0)
	if action != "hold" || qty != nil {
		t.Fatalf("oversized sell: want a hold, got %s %v", action, qty)
	}
}
