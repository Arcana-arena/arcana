// LP execution planning: turning a proposed LP action into the exact signer
// intents it needs.
//
// PHASE A OF THE MONEY PATH, AND IT DOES NOT MOVE MONEY. The assembly is the
// part that is easy to get subtly wrong — the right sequence, the right
// numbers, the slippage floors, the deadlines — so it is built and run first,
// against the real queue, with every intent logged instead of sent. Arming
// (calling the signer, broadcasting, recording) is a separate checkpoint; the
// signer's chain checks and the chain itself stay the last doors either way.
//
// IT REFUSES EARLY WHERE THE CHECK IS CHEAP. The position must be owned by the
// wallet the registry attributes to the same agent, an `empty` position must
// actually be empty, a `rebalance` must actually be out of range, and the
// proposal's mint plan must be present and well-formed. The signer re-checks
// all of this on chain before it signs anything; this layer exists so a drifted
// or stale queue item is refused with a reason in a log rather than becoming a
// refused signature nobody can explain.
package execution

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// LPProposal is one proposed action, as /v1/arbitrage/lp/actions returns it.
type LPProposal struct {
	ID             int64           `json:"id"`
	TokenID        string          `json:"token_id"`
	AgentID        string          `json:"agent_id"`
	Recommendation string          `json:"recommendation"`
	Detail         json.RawMessage `json:"detail"`
}

// LPRegistryRow is the registry subset this planner needs.
type LPRegistryRow struct {
	TokenID string `json:"token_id"`
	AgentID string `json:"agent_id"`
	Wallet  string `json:"wallet"`
	Status  string `json:"status"`
}

// LPPositionRead is the live position subset this planner needs, from
// /v1/arbitrage/lp/position.
type LPPositionRead struct {
	TokenID     string `json:"token_id"`
	Owner       string `json:"owner"`
	Token0      string `json:"token0"`
	Token1      string `json:"token1"`
	Fee         uint32 `json:"fee"`
	TickLower   int32  `json:"tick_lower"`
	TickUpper   int32  `json:"tick_upper"`
	Liquidity   string `json:"liquidity"`
	CurrentTick int32  `json:"current_tick"`
	InRange     bool   `json:"in_range"`
	Amount0     string `json:"amount0"`
	Amount1     string `json:"amount1"`
}

// LPIntent is one signer request body — the complete object that would be
// POSTed to /internal/v1/signer/sign, field for field.
type LPIntent struct {
	Intent string         `json:"intent"`
	Body   map[string]any `json:"body"`
}

// LPActionPlan is the planner's verdict on one proposal: an ordered intent
// sequence, or a refusal with a reason. Never both.
type LPActionPlan struct {
	ActionID       int64      `json:"action_id"`
	TokenID        string     `json:"token_id"`
	AgentID        string     `json:"agent_id"`
	Recommendation string     `json:"recommendation"`
	Intents        []LPIntent `json:"intents,omitempty"`
	Refusal        string     `json:"refusal,omitempty"`
}

// lpProposalDetail is the subset of the action's detail JSON this planner
// reads. The detail is written by the arbitrage loop; see its actionDetail.
type lpProposalDetail struct {
	Plan *struct {
		TickLower      int32  `json:"tick_lower"`
		TickUpper      int32  `json:"tick_upper"`
		Amount0Desired string `json:"amount0_desired"`
		Amount1Desired string `json:"amount1_desired"`
		Amount0Min     string `json:"amount0_min"`
		Amount1Min     string `json:"amount1_min"`
	} `json:"plan"`
	SlippageBps float64 `json:"slippage_bps"`
}

// PlanLPAction assembles the intent sequence for one proposal.
//
// THE ORDER IS PART OF THE ANSWER, and it is the order the CONTRACT allows, not
// the one that reads naturally:
//
//   - lp_decrease first: it removes the whole liquidity and writes the removed
//     principal — plus the fees accrued up to that block — into tokensOwed.
//   - lp_collect second: the position manager's burn refuses while tokensOwed
//     is non-zero ('Not cleared'), so the amount the decrease just credited has
//     to be swept BEFORE the burn. A collect placed first would leave the
//     decrease's own credit behind and the burn would revert.
//   - lp_burn third: legal only with liquidity 0 and tokensOwed 0, i.e. only
//     after both.
//   - lp_mint last: the fresh range from the proposal's plan.
//
// For an empty position there is nothing to decrease, so the sequence is
// lp_collect → lp_burn. As separate signed transactions each step depends on
// its predecessor being mined; the executor runs them that way, and the
// contract's own checks make a wrong order revert rather than half-execute.
//
// THE DEADLINE IS NOT OPTIONAL, and the signer's default of 0 is a trap: the
// position manager reverts a mint or a decrease whose deadline has passed, and
// 0 has always passed. deadlineUnix is computed by the caller immediately
// before the bodies are used — a plan that sat in a queue must not carry a
// deadline that expired while it waited.
func PlanLPAction(p LPProposal, row LPRegistryRow, pos *LPPositionRead, npm string, deadlineUnix int64) LPActionPlan {
	out := LPActionPlan{
		ActionID:       p.ID,
		TokenID:        p.TokenID,
		AgentID:        p.AgentID,
		Recommendation: p.Recommendation,
	}
	if strings.TrimSpace(npm) == "" {
		out.Refusal = "no position manager configured on the arbitrage side"
		return out
	}
	if row.TokenID != p.TokenID {
		out.Refusal = "the registry has no row for this position"
		return out
	}
	if row.AgentID != p.AgentID {
		out.Refusal = "the registry attributes this position to a different agent"
		return out
	}
	if pos == nil {
		out.Refusal = "position could not be read from the chain"
		return out
	}
	// The one check that binds the plan to a wallet: everything the signer will
	// do, it does for the agent's own wallet, so a proposal for a position the
	// chain says somebody else owns is refused here with both addresses
	// printed — not silently dropped.
	if !strings.EqualFold(pos.Owner, row.Wallet) {
		out.Refusal = fmt.Sprintf(
			"the chain says the owner is %s and the registry says %s — refusing to plan for a wallet the record does not name",
			pos.Owner, row.Wallet)
		return out
	}
	liquidity, ok := new(big.Int).SetString(pos.Liquidity, 10)
	if !ok {
		out.Refusal = fmt.Sprintf("liquidity %q is not a number", pos.Liquidity)
		return out
	}

	var d lpProposalDetail
	if err := json.Unmarshal(p.Detail, &d); err != nil {
		out.Refusal = "the proposal detail is unreadable: " + err.Error()
		return out
	}
	// A slippage that is absent or nonsensical makes the decrease floors below
	// meaningless, and a floor of zero is how a decrease gets sandwiched.
	if !(d.SlippageBps > 0) || d.SlippageBps >= 10000 {
		out.Refusal = fmt.Sprintf("the proposal carries no usable slippage (slippage_bps=%v)", d.SlippageBps)
		return out
	}
	if deadlineUnix <= 0 {
		out.Refusal = "no deadline was supplied; the position manager would revert the whole sequence"
		return out
	}

	// The signer parses `amount` before it looks at the intent, so every lp_*
	// body carries one; it bounds nothing in these shapes.
	collect := LPIntent{Intent: "lp_collect", Body: map[string]any{
		"amount":   "0",
		"router":   npm,
		"token_id": p.TokenID,
	}}

	switch p.Recommendation {
	case "empty":
		if liquidity.Sign() != 0 {
			out.Refusal = "the recommendation is empty but the position still holds liquidity — that is a rebalance, not a close"
			return out
		}
		out.Intents = []LPIntent{collect, {Intent: "lp_burn", Body: map[string]any{
			"amount":   "0",
			"router":   npm,
			"token_id": p.TokenID,
		}}}

	case "rebalance":
		if liquidity.Sign() == 0 {
			out.Refusal = "the recommendation is rebalance but the position has no liquidity — that is a close, not a rebalance"
			return out
		}
		if pos.InRange {
			out.Refusal = "the price is back inside the position's own range, so the rebalance no longer holds"
			return out
		}
		if d.Plan == nil {
			out.Refusal = "the proposal carries no mint plan"
			return out
		}
		if d.Plan.TickLower >= d.Plan.TickUpper {
			out.Refusal = fmt.Sprintf("the mint plan's range is empty or inverted (%d >= %d)", d.Plan.TickLower, d.Plan.TickUpper)
			return out
		}
		// Floors for the decrease: what the position holds now, discounted by
		// the proposal's own slippage. The amounts are the exact tokens a full
		// decrease returns, so a floor below them by the tolerance is the
		// difference between a sandwich and a revert.
		min0, ok0 := floorScale(pos.Amount0, d.SlippageBps)
		min1, ok1 := floorScale(pos.Amount1, d.SlippageBps)
		if !ok0 || !ok1 {
			out.Refusal = fmt.Sprintf("the position's current amounts are not numbers (%q, %q)", pos.Amount0, pos.Amount1)
			return out
		}
		decrease := LPIntent{Intent: "lp_decrease", Body: map[string]any{
			"amount":      "0",
			"router":      npm,
			"token_id":    p.TokenID,
			"liquidity":   pos.Liquidity,
			"amount0_min": min0,
			"amount1_min": min1,
			"deadline":    fmt.Sprintf("%d", deadlineUnix),
		}}
		// The collect AFTER the decrease, because decrease credits principal
		// and fees to tokensOwed and burn refuses while it is non-zero.
		collectAfter := LPIntent{Intent: "lp_collect", Body: map[string]any{
			"amount":   "0",
			"router":   npm,
			"token_id": p.TokenID,
		}}
		burn := LPIntent{Intent: "lp_burn", Body: map[string]any{
			"amount":   "0",
			"router":   npm,
			"token_id": p.TokenID,
		}}
		mint := LPIntent{Intent: "lp_mint", Body: map[string]any{
			"amount":          "0",
			"router":          npm,
			"token_in":        pos.Token0,
			"token_out":       pos.Token1,
			"fee":             pos.Fee,
			"tick_lower":      d.Plan.TickLower,
			"tick_upper":      d.Plan.TickUpper,
			"amount0_desired": d.Plan.Amount0Desired,
			"amount1_desired": d.Plan.Amount1Desired,
			"amount0_min":     d.Plan.Amount0Min,
			"amount1_min":     d.Plan.Amount1Min,
			"deadline":        fmt.Sprintf("%d", deadlineUnix),
		}}
		out.Intents = []LPIntent{decrease, collectAfter, burn, mint}

	default:
		out.Refusal = fmt.Sprintf("unknown recommendation %q", p.Recommendation)
	}
	return out
}

// floorScale returns floor(v * (10000 − bps) / 10000) as a decimal string, and
// false when v is not a number — a value that cannot be parsed refuses the
// plan rather than becoming a floor of zero, which is the one mistake here
// that loses money instead of gas.
func floorScale(v string, bps float64) (string, bool) {
	n, ok := new(big.Int).SetString(v, 10)
	if !ok {
		return "", false
	}
	scaled := new(big.Int).Mul(n, big.NewInt(int64(10000-bps)))
	return scaled.Div(scaled, big.NewInt(10000)).String(), true
}
