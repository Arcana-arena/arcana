// Package capital decides what an agent does with its Morpho position, and
// refuses what it must not do. It holds no key, reads no chain and writes no
// row: the engine gives it a State and records what it answers.
//
// TWO FUNCTIONS, AND THE SECOND ONE IS THE PRODUCT.
//
//	Decide    the deterministic capital decider: the owner's mandate, applied
//	          to the position as it stands. One action per cycle.
//	Validate  runs on EVERY proposed action, whoever proposed it. architecture.md
//	          §17.7 day 6: "the LLM answers with a plausible borrow that breaches
//	          the mandate. That must be refused in code after the answer, never
//	          prevented by prompt wording." Decide's own answers go through it
//	          too, so the two cannot drift into disagreeing about what is allowed.
//
// UNITS: every amount is WHOLE units — USDG for borrow and repay, the collateral
// token for supply. The signer converts to base units with the allowlist's
// decimals; nothing here ever sees a base unit.
package capital

import (
	"fmt"
	"math"
)

// Mandate is the owner's instruction (capital_mandates).
type Mandate struct {
	MinHealthFactor      float64
	MaxBorrowRateBps     int
	LiquidityTriggerUSDG float64
	MaxBorrowUSDG        float64
	NeverSell            []string
}

// State is everything a capital decision may depend on, read by the engine.
type State struct {
	CollateralQty    float64 // posted in the market
	DebtUSDG         float64
	LLTV             float64
	OraclePrice      float64 // USDG per collateral token, Morpho's
	PoolPrice        float64 // 0 when unreadable
	WalletCollateral float64 // collateral token held in the wallet, not posted
	WalletUSDG       float64
	BorrowRateBps    float64 // current annual borrow rate
	AvailableUSDG    float64 // what the market can still lend

	// What the oracle does not check for itself (go-no-go-lending.md cond. 2).
	OracleUntrusted bool
	OracleWhy       string

	// The platform's caps, from the signer's allowlist. A mandate can only be
	// lower than these, never higher (§17.6).
	PlatformDebtCapUSDG float64
	PlatformTxCapUSDG   float64
}

type Kind string

const (
	Hold   Kind = "hold"
	Supply Kind = "supply"
	Borrow Kind = "borrow"
	Repay  Kind = "repay"
)

// Action is one proposed step. Reason is a stable code; Why is for a person.
type Action struct {
	Kind   Kind
	Amount float64
	Reason string
	Why    string
}

// Refusal is a proposed action that must not reach the signer.
type Refusal struct {
	Code   string
	Detail string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Detail }

// Smallest action worth a transaction. Below this the gas is the trade.
const minActionUSDG = 1.0

// floorMargin keeps a borrow a hair inside the floor rather than exactly on it.
// Decide and Validate compute the health factor in different orders, and a
// borrow sized to land exactly on 2.0 came back 1.9999999999999998 in
// Validate often enough to matter: the first live borrow, on 2026-09-24, was
// sized to the edge and got through by rounding luck. 0.1% is below any price
// move that matters and far above float error.
const floorMargin = 0.999

// repayTargetMargin puts a repay that restores the floor a little above it,
// so the next tick does not immediately find the position back under.
const repayTargetMargin = 1.1

// worstPrice is the lower of the oracle and the pool (go-no-go-lending.md
// condition 3). An unreadable pool leaves the oracle alone.
func (s State) worstPrice() float64 {
	if s.PoolPrice > 0 && s.PoolPrice < s.OraclePrice {
		return s.PoolPrice
	}
	return s.OraclePrice
}

// HealthAt is the worst-case health factor for a given collateral and debt.
// +Inf when nothing is owed.
func (s State) HealthAt(collateral, debt float64) float64 {
	if debt <= 0 {
		return math.Inf(1)
	}
	return collateral * s.worstPrice() * s.LLTV / debt
}

// debtCeiling is the most that may be owed: the lowest of the mandate, the
// platform cap, and what keeps the worst-case health factor at the floor.
func debtCeiling(m Mandate, s State, collateral float64) float64 {
	c := math.Min(m.MaxBorrowUSDG, s.PlatformDebtCapUSDG)
	if m.MinHealthFactor > 0 {
		c = math.Min(c, collateral*s.worstPrice()*s.LLTV/m.MinHealthFactor*floorMargin)
	}
	return c
}

// Decide applies the mandate. In priority order:
//
//  1. under the floor      repay back above it, from the wallet's USDG
//  2. rate above mandate   repay what the wallet can, borrow nothing
//  3. cash under trigger   borrow up to the trigger — supplying collateral
//     first if the floor would not allow the borrow
//  4. cash well over it    repay the excess
//  5. otherwise            hold
func Decide(m Mandate, s State) Action {
	hf := s.HealthAt(s.CollateralQty, s.DebtUSDG)

	if s.DebtUSDG > 0 && hf < m.MinHealthFactor {
		target := s.CollateralQty * s.worstPrice() * s.LLTV / (m.MinHealthFactor * repayTargetMargin)
		need := s.DebtUSDG - target
		amt := math.Min(need, math.Min(s.WalletUSDG, s.DebtUSDG))
		if amt < minActionUSDG {
			return Action{Hold, 0, "repay_needed_no_usdg", fmt.Sprintf(
				"health factor %.2f is under the mandate's %.2f and the wallet holds %.2f USDG to repay with. "+
					"Selling collateral to repay is deleverage, which is not enabled yet", hf, m.MinHealthFactor, s.WalletUSDG)}
		}
		return Action{Repay, amt, "health_below_floor", fmt.Sprintf(
			"worst-case health factor %.2f is under the mandate's %.2f; repaying %.2f USDG", hf, m.MinHealthFactor, amt)}
	}

	if s.BorrowRateBps > float64(m.MaxBorrowRateBps) {
		if s.DebtUSDG > 0 {
			amt := math.Min(s.DebtUSDG, s.WalletUSDG)
			if amt >= minActionUSDG {
				return Action{Repay, amt, "rate_above_mandate", fmt.Sprintf(
					"borrowing costs %.0f bps a year and the mandate allows %d; repaying %.2f USDG",
					s.BorrowRateBps, m.MaxBorrowRateBps, amt)}
			}
		}
		return Action{Hold, 0, "rate_above_mandate", fmt.Sprintf(
			"borrowing costs %.0f bps a year and the mandate allows %d; not borrowing", s.BorrowRateBps, m.MaxBorrowRateBps)}
	}

	if s.WalletUSDG < m.LiquidityTriggerUSDG {
		if s.OracleUntrusted {
			return Action{Hold, 0, "oracle_untrusted", "cash is under the trigger, but " + s.OracleWhy}
		}
		want := m.LiquidityTriggerUSDG - s.WalletUSDG
		room := debtCeiling(m, s, s.CollateralQty) - s.DebtUSDG
		amt := math.Min(want, math.Min(room, math.Min(s.PlatformTxCapUSDG, s.AvailableUSDG)))
		if amt >= minActionUSDG {
			return Action{Borrow, amt, "liquidity_below_trigger", fmt.Sprintf(
				"the wallet holds %.2f USDG against a trigger of %.2f; borrowing %.2f", s.WalletUSDG, m.LiquidityTriggerUSDG, amt)}
		}
		// The floor is what stopped it. Posting wallet collateral would make
		// room — that is not a sale, so a never-sell symbol may be posted.
		if s.WalletCollateral > 0 && s.worstPrice() > 0 {
			need := (s.DebtUSDG + math.Min(want, s.PlatformTxCapUSDG)) * m.MinHealthFactor / (s.worstPrice() * s.LLTV)
			add := math.Min(need-s.CollateralQty, s.WalletCollateral)
			if add > 0 && add*s.worstPrice() >= minActionUSDG {
				return Action{Supply, add, "collateral_for_liquidity", fmt.Sprintf(
					"cash is under the trigger and the floor leaves no room to borrow; posting %.6f as collateral first", add)}
			}
		}
		return Action{Hold, 0, "no_room_to_borrow", fmt.Sprintf(
			"cash is under the trigger, but the mandate, the platform cap, the floor or the market's liquidity leaves %.2f USDG of room", math.Max(amt, 0))}
	}

	if s.DebtUSDG > 0 && s.WalletUSDG > 2*m.LiquidityTriggerUSDG {
		amt := math.Min(s.DebtUSDG, s.WalletUSDG-m.LiquidityTriggerUSDG)
		if amt >= minActionUSDG {
			return Action{Repay, amt, "excess_liquidity", fmt.Sprintf(
				"the wallet holds %.2f USDG, more than twice the %.2f trigger; repaying %.2f", s.WalletUSDG, m.LiquidityTriggerUSDG, amt)}
		}
	}
	return Action{Hold, 0, "within_mandate", "nothing in the mandate asks for a change"}
}

// Validate is the rule that holds whatever proposed the action.
func Validate(a Action, m Mandate, s State) *Refusal {
	refuse := func(code, f string, args ...any) *Refusal { return &Refusal{code, fmt.Sprintf(f, args...)} }
	switch a.Kind {
	case Hold:
		return nil
	case Supply, Borrow, Repay:
	default:
		return refuse("unknown_capital_action", "%q is not supply, borrow, repay or hold", a.Kind)
	}
	if !(a.Amount > 0) || math.IsInf(a.Amount, 0) {
		return refuse("amount_not_positive", "%v is not an amount", a.Amount)
	}

	switch a.Kind {
	case Supply:
		if a.Amount > s.WalletCollateral {
			return refuse("insufficient_collateral_in_wallet", "supplying %.6f but the wallet holds %.6f", a.Amount, s.WalletCollateral)
		}
	case Repay:
		if a.Amount > s.WalletUSDG {
			return refuse("insufficient_usdg", "repaying %.2f but the wallet holds %.2f USDG", a.Amount, s.WalletUSDG)
		}
		if a.Amount > s.DebtUSDG+0.000001 {
			return refuse("repay_over_debt", "repaying %.2f against a debt of %.2f", a.Amount, s.DebtUSDG)
		}
	case Borrow:
		if s.OracleUntrusted {
			return refuse("oracle_untrusted", "%s", s.OracleWhy)
		}
		if s.BorrowRateBps > float64(m.MaxBorrowRateBps) {
			return refuse("rate_above_mandate", "the rate is %.0f bps a year and the mandate allows %d", s.BorrowRateBps, m.MaxBorrowRateBps)
		}
		if a.Amount > s.PlatformTxCapUSDG {
			return refuse("borrow_over_tx_cap", "%.2f USDG is over the platform's %.2f per transaction", a.Amount, s.PlatformTxCapUSDG)
		}
		after := s.DebtUSDG + a.Amount
		if after > m.MaxBorrowUSDG+0.000001 {
			return refuse("over_mandate_borrow_cap", "debt would be %.2f USDG and the mandate allows %.2f", after, m.MaxBorrowUSDG)
		}
		if after > s.PlatformDebtCapUSDG+0.000001 {
			return refuse("debt_over_agent_cap", "debt would be %.2f USDG and the platform allows %.2f per agent", after, s.PlatformDebtCapUSDG)
		}
		if hf := s.HealthAt(s.CollateralQty, after); hf < m.MinHealthFactor {
			return refuse("below_health_floor", "the worst-case health factor would be %.2f and the mandate's floor is %.2f", hf, m.MinHealthFactor)
		}
		if a.Amount > s.AvailableUSDG {
			return refuse("market_liquidity", "the market can lend %.2f USDG", s.AvailableUSDG)
		}
	}
	return nil
}

// NeverSellRefusal is the mandate's never-sell list, applied to a TRADING
// decision. A sell of a listed symbol is refused whoever proposed it.
func NeverSellRefusal(m Mandate, side, symbol string) *Refusal {
	if side != "SELL" && side != "sell" {
		return nil
	}
	for _, s := range m.NeverSell {
		if s == symbol {
			return &Refusal{"never_sell", fmt.Sprintf("the capital mandate lists %s as never-sell", symbol)}
		}
	}
	return nil
}
