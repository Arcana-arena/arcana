package engine

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

// Who may hold an agent's execution lease, and for how long.
//
// THE TTL IS DERIVED FROM THE SLOWEST THING IT COVERS. A cycle holds the lease
// across a chain read, a signer call, a broadcast, and a receipt wait that the
// broker bounds at 90 seconds — plus a second read. Three minutes leaves room
// for all of it and still expires inside a single cadence interval, so a
// process that dies mid-swap blocks its agent for one tick and not for a day.
const (
	leaseHolderCycle = "cycle"
	leaseHolderGuard = "guard"
	LeaseTTL         = 3 * time.Minute
)

// ReasonPositionLocked is recorded when an actor stood down because another
// one held the lease. It is not a failure and not a risk decision: it is one
// intent declining to become a second transaction.
const ReasonPositionLocked = "position_locked"

// applyGuardChanges arms or clears protective levels once the decision exists.
//
// EVERY FAILURE HERE IS LOUD. A guard that was asked for and not armed is the
// worst outcome this feature has: the owner believes a stop loss is watching
// and nothing is. It cannot fail the tick — the trade already happened on chain
// — so it logs at ERROR and the decision's rationale already says what was
// meant to be armed.
func (e *Engine) applyGuardChanges(ctx context.Context, agentID string, decisionID int64, s settlement) {
	if s.ClearGuard != "" {
		if err := e.store.ClearGuards(ctx, agentID, s.ClearGuard,
			"the agent exited this position by its own decision"); err != nil {
			log.Printf("ERROR agent %s: guard on %s not cleared after an exit: %v", agentID, s.ClearGuard, err)
		}
	}
	if s.Guard == nil {
		return
	}
	g := s.Guard
	id, err := e.store.ArmGuard(ctx, store.GuardInsert{
		AgentID: agentID, Symbol: g.Symbol,
		EntryPrice: g.EntryPrice, EntryQty: g.EntryQty,
		TakeProfit: g.Levels.TakeProfit, StopLoss: g.Levels.StopLoss,
		TPPct: g.Levels.TPPct, SLPct: g.Levels.SLPct,
		DecisionID: &decisionID, Note: g.Basis,
	})
	if err != nil {
		log.Printf("ERROR agent %s: protective levels for %s were NOT armed and the position is "+
			"unguarded: %v", agentID, g.Symbol, err)
		return
	}
	log.Printf("agent %s: guard %d armed on %s, entry %.6f%s", agentID, id, g.Symbol,
		g.EntryPrice, guardSummary(g.Levels, g.EntryPrice))
}

// Take-profit and stop-loss levels, as the agent may ask for them and as the
// system is willing to hold them.
//
// WHY PERCENTAGES ARE A REQUEST AND LEVELS ARE A FACT. The model says "exit if
// this falls 5%". That is a statement about trading style and it belongs to the
// owner. What it becomes is an absolute price, computed ONCE from the price
// actually paid, and from then on nothing recomputes it. A level that were
// re-derived on every scan would move whenever the believed entry price moved,
// which is a level the owner never agreed to and could never check.
//
// THE BOUNDS BELOW ARE NOT TASTE, and they are not safety limits either — the
// safety limits are elsewhere and this cannot reach them. They exist because a
// level outside these ranges is not a level:
//
//   - a stop at or below zero can never be crossed by a price, so it is a guard
//     that watches forever and never fires: a promise the record would carry
//     and the system would never keep;
//   - a stop of 100% or more is the same thing said differently;
//   - a target below the entry price fires the instant it is armed, turning a
//     take-profit into an immediate sell that the owner did not ask for;
//   - a stop above the entry price does the same in the other direction.
//
// Each of those is refused with the reason named, and the buy still happens.
// A malformed level must not cost the agent its trade.
// MaxGuardPct bounds the far end. A stop 100% below entry cannot be crossed;
// anything approaching it is a guard in name only.
const MaxGuardPct = 0.95

// roundTripPct is what it costs to open a position and close it again, in the
// pool this symbol trades in, as a fraction of the entry price.
//
// THE NEAR BOUND IS THIS NUMBER, AND IT IS NOT A CHOSEN ONE.
//
// Buying pays the fee and selling pays it again. So immediately after entry:
//
//	entry paid  = mid x (1 + fee)
//	realizable  = mid x (1 - fee)
//	realizable / entry = (1 - fee) / (1 + fee) ~= 1 - 2 x fee
//
// A stop at `entry x (1 - p)` is therefore crossed AT THE MOMENT OF ENTRY
// whenever p <= 2 x fee. Not after a move, not after a loss — at open, by the
// arithmetic of the round trip alone. Such a level is not protection; it is an
// instruction to buy and immediately sell at a loss, and an owner who typed
// "exit if it drops 0.3%" did not mean that.
//
// MY FIRST VERSION GOT THIS WRONG. It used one flat 0.4%, reasoning from ONE
// side of the round trip on the widest pool. On the 0.3% pools the round trip
// is 0.6%, so every level between 0.4% and 0.6% would have been accepted and
// would have fired on its own entry — and I only saw it while working out how
// to trigger a stop on purpose for the verification. The bound now comes from
// the pool the symbol actually trades in: 0.1% on the 5 bp pools, 0.6% on the
// 30 bp ones.
func roundTripPct(feeTier uint32) float64 {
	return 2 * float64(feeTier) / 1e6
}

// guardLevels is what a decider asked for, before validation.
type guardLevels struct {
	TakeProfitPct float64
	StopLossPct   float64
}

func (g guardLevels) any() bool { return g.TakeProfitPct > 0 || g.StopLossPct > 0 }

// armedLevels is what will actually be written, with the absolute prices.
type armedLevels struct {
	TakeProfit *float64
	StopLoss   *float64
	TPPct      *float64
	SLPct      *float64
	// Refusals names each level that was asked for and not armed, so the
	// decision's rationale can say so. Silently dropping a stop loss would be
	// the worst possible failure of this feature: the owner believes they are
	// protected and nothing is watching.
	Refusals []string
}

func (a armedLevels) any() bool { return a.TakeProfit != nil || a.StopLoss != nil }

// resolveGuardLevels turns requested percentages into absolute prices.
//
// entry is the price ACTUALLY PAID, measured from the execution. Passing a
// quoted or intended price here would anchor every level to a number that did
// not happen.
func resolveGuardLevels(req guardLevels, entry float64, feeTier uint32) armedLevels {
	var out armedLevels
	if entry <= 0 {
		out.Refusals = append(out.Refusals,
			"no levels armed: the entry price could not be measured from the fill")
		return out
	}
	rt := roundTripPct(feeTier)

	if req.StopLossPct > 0 {
		switch {
		case req.StopLossPct <= rt:
			// <=, not <. At exactly the round trip the level is crossed at the
			// moment of entry, because the comparison is inclusive and the
			// realizable price is already that far below what was paid.
			out.Refusals = append(out.Refusals, fmt.Sprintf(
				"stop loss of %.3f%% refused: this pool charges %.2f%% each way, so a position is "+
					"already %.3f%% underwater the instant it opens and this level would fire on "+
					"its own entry rather than on a move (must exceed %.3f%%)",
				req.StopLossPct*100, float64(feeTier)/1e4, rt*100, rt*100))
		case req.StopLossPct > MaxGuardPct:
			out.Refusals = append(out.Refusals, fmt.Sprintf(
				"stop loss of %.2f%% refused: a level that far below entry cannot be crossed "+
					"(maximum %.0f%%)", req.StopLossPct*100, MaxGuardPct*100))
		default:
			lvl := entry * (1 - req.StopLossPct)
			pct := req.StopLossPct
			out.StopLoss, out.SLPct = &lvl, &pct
		}
	}

	if req.TakeProfitPct > 0 {
		switch {
		case req.TakeProfitPct <= rt:
			// A target cannot fire at open — the arithmetic runs the other way
			// — but one inside the round trip is a "take profit" that realises
			// LESS than was paid. Refused because the name would be false, and
			// an owner reading "take profit fired" would draw the wrong
			// conclusion about their agent.
			out.Refusals = append(out.Refusals, fmt.Sprintf(
				"take profit of %.3f%% refused: this pool charges %.2f%% each way, so exiting "+
					"there would realise less than was paid (must exceed %.3f%%)",
				req.TakeProfitPct*100, float64(feeTier)/1e4, rt*100))
		default:
			lvl := entry * (1 + req.TakeProfitPct)
			pct := req.TakeProfitPct
			out.TakeProfit, out.TPPct = &lvl, &pct
		}
	}

	return out
}

// guardSummary is the sentence appended to a decision's rationale, so the
// record of the buy also says what was armed on the way in.
func guardSummary(a armedLevels, entry float64) string {
	if !a.any() && len(a.Refusals) == 0 {
		return ""
	}
	s := ""
	if a.StopLoss != nil {
		s += fmt.Sprintf(" | stop loss armed at %.4f (%.2f%% below the %.4f paid)",
			*a.StopLoss, *a.SLPct*100, entry)
	}
	if a.TakeProfit != nil {
		s += fmt.Sprintf(" | take profit armed at %.4f (%.2f%% above the %.4f paid)",
			*a.TakeProfit, *a.TPPct*100, entry)
	}
	for _, r := range a.Refusals {
		s += " | " + r
	}
	return s
}

// crossed reports which level a price has reached, if any.
//
// GREATER-OR-EQUAL AND LESS-OR-EQUAL, deliberately: a level is a price the
// owner named, and a price that equals it has reached it. Strict comparison
// would make a level that is exactly hit do nothing, which is impossible to
// explain to whoever set it.
//
// The stop is tested FIRST. If a price somehow satisfies both — which the
// schema's ordering constraint prevents, but which a future edit could
// reintroduce — protecting capital is the one to act on.
func crossed(g struct{ TakeProfit, StopLoss *float64 }, price float64) string {
	if g.StopLoss != nil && price <= *g.StopLoss {
		return "stop_loss"
	}
	if g.TakeProfit != nil && price >= *g.TakeProfit {
		return "take_profit"
	}
	return ""
}
