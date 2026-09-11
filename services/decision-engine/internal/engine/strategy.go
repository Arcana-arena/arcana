package engine

import (
	"fmt"
	"math"
	"sort"

	"github.com/arcana/decision-engine/internal/marketdata"
)

// ---------------------------------------------------------------------------
// Agent strategies.
//
// Selected by agents.strategy_type — the column already in §7 — so there is one
// place that decides how an agent behaves. The three implemented strategies are
// deliberately opposed in character rather than variations of one idea:
//
//	momentum        chases the mover, cuts what falls: high turnover
//	mean_reversion  buys weakness, sells strength: the mirror of momentum
//	buy_and_hold    builds a position once and stops trading: near-zero turnover
//
// Rationale and formulas: docs/scoring-formula.md (§strategy) documents how the
// scoring engine later measures whether an agent lived up to its declared type.
// ---------------------------------------------------------------------------

// RiskLimits are the parts of agents.risk_profile (JSONB) that actually steer
// behaviour. Until now the column was stored and never read.
type RiskLimits struct {
	// MaxPositionPct caps one symbol as a fraction of NAV.
	MaxPositionPct float64
	// TradeSizePct is how much of NAV a single trade commits.
	TradeSizePct float64
	// CashFloorPct is the fraction of NAV never spent, so an agent always
	// keeps powder dry and cannot trade itself to a standstill.
	CashFloorPct float64
	// RebalanceBandPct is the price move required before acting. It is what
	// separates a strategy that reacts to noise from one that waits for a
	// real move.
	RebalanceBandPct float64

	// QtyStep is the smallest quantity the asset can actually be traded in.
	//
	// IT IS A PROPERTY OF THE ASSET, NOT A RISK LIMIT, and it lives here
	// because buyableQty is where it bites. It used to be the constant 0.01
	// written into that function, which was invisible while capital was
	// imaginary: on a 100,000 book a hundredth of a share is nothing.
	//
	// On 11.79 of real money it silently forbade every purchase of anything
	// expensive. A budget of 5.89 against SPY at ~660 is 0.0089 shares, which
	// floors to zero — and the decision was recorded as "buy declined by risk
	// limits", language that reads as a deliberate risk decision rather than as
	// arithmetic nobody had revisited since capital became real. The model
	// asked to buy twice and was refused both times before the intent ever
	// reached the chain.
	//
	// Tokens on chain divide to eighteen decimals. The binding limit is what
	// can be RECORDED: decisions.quantity is numeric(20,8), so trading finer
	// than 1e-8 would write down a number that is not what happened.
	QtyStep float64

	// StopLossPct and TakeProfitPct are STANDING protective levels, armed on
	// every position this agent opens unless the decider asks for its own.
	//
	// THEY ARE NOT LIMITS AND THEY CLAMP NOTHING. Everything else in this
	// struct bounds what a decision may be; these describe what happens after
	// one. They live here because risk_profile is where an owner already says
	// how their agent should behave, and "get me out at 5% down" is that kind
	// of statement. Zero means none.
	StopLossPct   float64
	TakeProfitPct float64

	// CostBudgetMonthlyPct is the share of its own capital this agent may spend
	// on gas and pool fees per 30 days before it stands down.
	//
	// THE OWNER'S LEVER, NOT THE PLATFORM'S, and it used to be the other way
	// round. A cost meter the platform set and enforced was deciding for an
	// owner how expensive a trading style they were allowed to have. On a small
	// book the arithmetic it reports is true and useful — costs are mostly fixed
	// per transaction, so a small book pays a large share of itself — but that
	// is a fact for the owner to act on, not a reason for the platform to stop
	// their agent.
	//
	// Zero is UNMETERED, and that is the default. An owner who wants their agent
	// to stand down when its costs cross a threshold sets this; nobody sets it
	// for them. The meter itself is unchanged, and is still proved by exceeding
	// it rather than by reading its branches.
	CostBudgetMonthlyPct float64
}

// Defaults for agents whose risk_profile does not say. Chosen to be active
// enough to produce visible behaviour within a short demo season.
var defaultLimits = RiskLimits{
	MaxPositionPct:   0.35,
	TradeSizePct:     0.20,
	CashFloorPct:     0.05,
	RebalanceBandPct: 0.003,
	// A hundredth of a share, which is what every virtual season has run on.
	// Chain-backed agents are given the finer step in Execute.
	QtyStep: 0.01,
}

// riskLimitsFrom reads the limits out of the agent's risk_profile.
//
// Accepts snake_case (preferred) and the camelCase keys already present in
// seeded rows. `max_risk_per_trade` / `maxRiskPerTrade` map to TradeSizePct:
// both express "how much of the book one trade may commit".
func riskLimitsFrom(profile map[string]any) RiskLimits {
	l := defaultLimits
	get := func(keys ...string) (float64, bool) {
		for _, k := range keys {
			if v, ok := profile[k]; ok {
				if f := toFloat(v); f > 0 {
					return f, true
				}
			}
		}
		return 0, false
	}
	if v, ok := get("max_position_pct", "maxPositionPct"); ok {
		l.MaxPositionPct = v
	}
	if v, ok := get("trade_size_pct", "tradeSizePct", "max_risk_per_trade", "maxRiskPerTrade"); ok {
		l.TradeSizePct = v
	}
	if v, ok := get("cash_floor_pct", "cashFloorPct"); ok {
		l.CashFloorPct = v
	}
	if v, ok := get("rebalance_band_pct", "rebalanceBandPct"); ok {
		l.RebalanceBandPct = v
	}
	// STANDING TP/SL, for agents whose levels are part of how they are set up
	// rather than something decided per trade. A deterministic strategy has no
	// way to ask for a level, and a model may choose not to; this is how an
	// owner says "always exit at 5% down" once instead of hoping.
	//
	// Not a risk limit, and it does not clamp anything. It is a standing
	// instruction that a per-trade request overrides.
	// BOTH NAMES ARE READ, AND THE UNAMBIGUOUS ONE WINS.
	//
	// These are FRACTIONS: 0.0015 is 0.15%, 0.05 is 5%. The original names said
	// "pct" and meant a fraction, and that hundredfold ambiguity produced a
	// live position guarded at 15% by an owner who had written 0.15%.
	//
	// The retired names keep working — an agent that set one months ago must
	// not silently stop being protected because the platform renamed a key —
	// and they are read FIRST so that an owner who has written both gets the
	// unambiguous one. agents.controller.ts names the old key back to whoever
	// used it, so it is deprecated out loud rather than quietly.
	if v, ok := get("stop_loss_pct", "stopLossPct"); ok {
		l.StopLossPct = v
	}
	if v, ok := get("stop_loss_fraction", "stopLossFraction"); ok {
		l.StopLossPct = v
	}
	if v, ok := get("take_profit_pct", "takeProfitPct"); ok {
		l.TakeProfitPct = v
	}
	if v, ok := get("take_profit_fraction", "takeProfitFraction"); ok {
		l.TakeProfitPct = v
	}
	// The owner's own cost brake. Absent means unmetered, which is the default
	// for every agent that has not asked for one.
	if v, ok := get("cost_budget_monthly_pct", "costBudgetMonthlyPct"); ok {
		l.CostBudgetMonthlyPct = v
	}
	// A trade that cannot fit under the position cap would never execute.
	if l.TradeSizePct > l.MaxPositionPct {
		l.TradeSizePct = l.MaxPositionPct
	}
	return l
}

// marketView is what a strategy is allowed to see: the current immutable
// snapshot and the one before it. Nothing else — no future data, no other
// agents' positions.
type marketView struct {
	symbols []marketdata.Quote
	prices  map[string]float64
	// prev is nil on the first tick of a season.
	prev map[string]float64
}

// ret is the symbol's return since the previous tick, and whether it is known.
func (m marketView) ret(symbol string) (float64, bool) {
	if m.prev == nil {
		return 0, false
	}
	before, ok := m.prev[symbol]
	if !ok || before <= 0 {
		return 0, false
	}
	now, ok := m.prices[symbol]
	if !ok {
		return 0, false
	}
	return (now - before) / before, true
}

// tradeIntent is a strategy's output for one tick.
type tradeIntent struct {
	Action    string // buy | sell | hold
	Symbol    string
	Quantity  float64
	Rationale string

	// Guards are the protective levels to arm if this intent opens a position.
	// Carried on the intent rather than applied by the decider, because the
	// levels have to be measured against the price the fill ACTUALLY got, and
	// that is not known until the chain has answered.
	Guards guardLevels
}

func hold(reason string) tradeIntent {
	return tradeIntent{Action: "hold", Rationale: reason}
}

// decide dispatches on the agent's declared strategy_type.
//
// An unrecognised or empty type falls back to buy_and_hold: it is the most
// conservative of the three, and it matches what every agent did before
// strategies existed (buy once, then sit). Failing closed into frantic
// trading would be the wrong default for an agent nobody configured.
func decide(strategyType string, view marketView, holdings map[string]any, cash, nav float64, l RiskLimits) tradeIntent {
	var out tradeIntent
	switch strategyType {
	case "momentum":
		out = momentumStrategy(view, holdings, cash, nav, l)
	case "mean_reversion":
		out = meanReversionStrategy(view, holdings, cash, nav, l)
	default:
		// buy_and_hold, "", and anything unrecognised.
		out = buyAndHoldStrategy(view, holdings, cash, nav, l)
	}
	// A coded strategy has no way to ask for protective levels, so its owner's
	// standing ones are attached here. Applied at the dispatch rather than
	// inside each strategy so a fourth strategy cannot forget.
	if out.Action == "buy" {
		out.Guards = guardLevels{StopLossPct: l.StopLossPct, TakeProfitPct: l.TakeProfitPct}
	}
	return out
}

// momentumStrategy chases the strongest mover and cuts positions that fall.
//
// Character: acts on almost every tick that shows a move beyond the band, so
// turnover is high and drawdowns are deeper — it is always holding whatever
// just went up.
func momentumStrategy(view marketView, holdings map[string]any, cash, nav float64, l RiskLimits) tradeIntent {
	ranked, ok := rankByReturn(view)
	if !ok {
		return hold("no prior tick to measure momentum against")
	}

	// Buy the leader while it is still rising.
	best := ranked[0]
	if best.ret > l.RebalanceBandPct {
		if qty := buyableQty(best.symbol, view, holdings, cash, nav, l); qty > 0 {
			return tradeIntent{
				Action: "buy", Symbol: best.symbol, Quantity: qty,
				Rationale: fmt.Sprintf("momentum: %s up %.2f%% since last tick, adding %.2f shares",
					best.symbol, best.ret*100, qty),
			}
		}
	}

	// Otherwise cut whatever is falling hardest.
	for i := len(ranked) - 1; i >= 0; i-- {
		c := ranked[i]
		if c.ret >= -l.RebalanceBandPct {
			break // sorted: nothing below this is a loser either
		}
		if held := HeldQty(holdings, c.symbol); held > 0 {
			return tradeIntent{
				Action: "sell", Symbol: c.symbol, Quantity: held,
				Rationale: fmt.Sprintf("momentum: %s down %.2f%%, exiting %.2f shares",
					c.symbol, c.ret*100, held),
			}
		}
	}
	return hold("momentum: no move beyond the rebalance band")
}

// meanReversionStrategy is momentum's mirror: it buys what fell and sells what
// rose, on the assumption that moves overshoot.
//
// Character: trades about as often as momentum but in the opposite direction,
// so on the same market the two produce visibly different holdings and NAV
// paths — which is the point of having both.
func meanReversionStrategy(view marketView, holdings map[string]any, cash, nav float64, l RiskLimits) tradeIntent {
	ranked, ok := rankByReturn(view)
	if !ok {
		return hold("no prior tick to measure reversion against")
	}

	// Buy the biggest decline.
	worst := ranked[len(ranked)-1]
	if worst.ret < -l.RebalanceBandPct {
		if qty := buyableQty(worst.symbol, view, holdings, cash, nav, l); qty > 0 {
			return tradeIntent{
				Action: "buy", Symbol: worst.symbol, Quantity: qty,
				Rationale: fmt.Sprintf("mean reversion: %s down %.2f%%, buying the dip with %.2f shares",
					worst.symbol, worst.ret*100, qty),
			}
		}
	}

	// Otherwise take profit on whatever rose.
	for _, c := range ranked {
		if c.ret <= l.RebalanceBandPct {
			break // sorted desc: nothing after this rose either
		}
		if held := HeldQty(holdings, c.symbol); held > 0 {
			return tradeIntent{
				Action: "sell", Symbol: c.symbol, Quantity: held,
				Rationale: fmt.Sprintf("mean reversion: %s up %.2f%%, selling into strength (%.2f shares)",
					c.symbol, c.ret*100, held),
			}
		}
	}
	return hold("mean reversion: no move beyond the rebalance band")
}

// buyAndHoldStrategy builds its position once and then stops.
//
// Character: it trades only while a symbol in the universe is still unowned.
// After that every tick is a hold, forever — which is what makes its turnover
// the natural floor to compare the other two against.
func buyAndHoldStrategy(view marketView, holdings map[string]any, cash, nav float64, l RiskLimits) tradeIntent {
	// Deterministic order so the same market produces the same build-out.
	symbols := make([]string, 0, len(view.symbols))
	for _, q := range view.symbols {
		symbols = append(symbols, q.Symbol)
	}
	sort.Strings(symbols)

	for _, sym := range symbols {
		if HasPosition(holdings, sym) {
			continue // already own it; buy-and-hold never tops up
		}
		if qty := buyableQty(sym, view, holdings, cash, nav, l); qty > 0 {
			return tradeIntent{
				Action: "buy", Symbol: sym, Quantity: qty,
				Rationale: fmt.Sprintf("buy and hold: opening %.2f shares of %s", qty, sym),
			}
		}
	}
	return hold("buy and hold: position established, holding")
}

// --- shared mechanics ---

type symbolReturn struct {
	symbol string
	ret    float64
}

// rankByReturn sorts symbols by return since the previous tick, best first.
// Returns false when no return can be computed (first tick of a season).
func rankByReturn(view marketView) ([]symbolReturn, bool) {
	ranked := make([]symbolReturn, 0, len(view.symbols))
	for _, q := range view.symbols {
		if r, ok := view.ret(q.Symbol); ok {
			ranked = append(ranked, symbolReturn{symbol: q.Symbol, ret: r})
		}
	}
	if len(ranked) == 0 {
		return nil, false
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].ret == ranked[j].ret {
			return ranked[i].symbol < ranked[j].symbol // stable, deterministic
		}
		return ranked[i].ret > ranked[j].ret
	})
	return ranked, true
}

// buyableQty is how many shares the agent may buy of a symbol right now, after
// applying every risk limit. Returns 0 when a limit forbids the trade — this
// is where risk_profile stops being decoration and starts constraining.
func buyableQty(symbol string, view marketView, holdings map[string]any, cash, nav float64, l RiskLimits) float64 {
	price, ok := view.prices[symbol]
	if !ok || price <= 0 || nav <= 0 {
		return 0
	}

	// Never spend into the cash floor.
	spendable := cash - nav*l.CashFloorPct
	if spendable <= 0 {
		return 0
	}

	// Never exceed the per-position ceiling.
	headroom := nav*l.MaxPositionPct - qtyFromHoldings(holdings, symbol)*price
	if headroom <= 0 {
		return 0
	}

	budget := math.Min(math.Min(nav*l.TradeSizePct, spendable), headroom)
	step := l.QtyStep
	if step <= 0 {
		step = defaultLimits.QtyStep
	}
	qty := math.Floor(budget/price/step) * step
	if qty < step {
		return 0
	}
	return qty
}

// applyIntent settles a trade against cash and holdings at snapshot prices.
// Returns the action actually recorded: a trade that cannot settle degrades to
// a hold rather than failing the tick, matching the §13 rule that a missing
// decision is recorded as a hold rather than lost.
func applyIntent(in tradeIntent, prices map[string]float64, holdings map[string]any, cash float64) (string, string, *float64, map[string]any, float64, string) {
	switch in.Action {
	case "buy":
		price, ok := prices[in.Symbol]
		if !ok || in.Quantity <= 0 || price*in.Quantity > cash {
			return "hold", "", nil, holdings, cash, "trade skipped: " + in.Rationale
		}
		out := cloneHoldings(holdings)
		out[in.Symbol] = qtyFromHoldings(out, in.Symbol) + in.Quantity
		qty := in.Quantity
		return "buy", in.Symbol, &qty, out, cash - price*in.Quantity, in.Rationale

	case "sell":
		price, ok := prices[in.Symbol]
		// HeldQty, not the raw figure: a position too small to write down is
		// not one this can build a sell out of.
		have := HeldQty(holdings, in.Symbol)
		if !ok || in.Quantity <= 0 || in.Quantity > have {
			return "hold", "", nil, holdings, cash, "trade skipped: " + in.Rationale
		}
		out := cloneHoldings(holdings)
		// A remainder below the floor is deleted rather than kept. The old
		// bound here was 1e-9, which is neither the precision of the column nor
		// the precision of anything else -- it was a number that looked small.
		if remaining := have - in.Quantity; remaining < DustFloor {
			delete(out, in.Symbol)
		} else {
			out[in.Symbol] = remaining
		}
		qty := in.Quantity
		return "sell", in.Symbol, &qty, out, cash + price*in.Quantity, in.Rationale

	default:
		return "hold", "", nil, holdings, cash, in.Rationale
	}
}
