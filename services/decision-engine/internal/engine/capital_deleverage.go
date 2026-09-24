package engine

// DELEVERAGE, between ticks. architecture.md §17.6 acceptance 5: "sees the
// agent deleverage as the health factor approaches the floor — between ticks,
// not only on one". The mandate's own cycle runs on the agent's cadence, which
// can be hours; a health factor checked only then is not risk protection. So
// the position guard, which already reads every position once a minute, acts
// here when the worst-case health factor is under the mandate's floor.
//
// ONE STEP PER SCAN, in this order, each re-read from the chain first:
//
//  1. repay from USDG the wallet already holds;
//  2. otherwise sell collateral the wallet holds but has not posted;
//  3. otherwise take some collateral back from the market — never so much
//     that the health factor would fall under withdrawSafety — so that the
//     next scan can sell it and the one after can repay.
//
// Each step is recorded in capital_actions with decider "deleverage" and the
// figures it was taken on. It runs for an agent that is ACTIVE or PAUSED:
// pausing stops an agent deciding, not its protection (§17.4). A stopped or
// absent mandate is the owner's hand on the position; the guard then watches
// and alerts, and does not act.
//
// NEVER-SELL DOES NOT STOP IT. A mandate that lists the collateral as
// never-sell has also set a floor, and under that floor the choice is no
// longer between selling and keeping: a liquidation sells the same collateral
// at a penalty. The owner's floor is the instruction that governs here, and
// docs/capital.md and the mandate form say so.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"

	"github.com/arcana/decision-engine/internal/capital"
	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

const (
	// deleverageTargetMargin restores the health factor a little above the
	// floor, so the next scan does not find it straight back under.
	deleverageTargetMargin = 1.1
	// withdrawSafety is the health factor a deleverage withdrawal may not take
	// the position below. Morpho refuses under 1.0; this keeps a margin for the
	// minute between taking collateral back and selling it.
	withdrawSafety = 1.05
	// sellSlippage over-sells a little so the proceeds cover what the repay
	// needs after the pool fee and slippage.
	sellSlippage = 1.02
	// leaseHolderDeleverage is the lease holder for a deleverage step.
	leaseHolderDeleverage = "guard"
)

// deleverage takes at most one step on one position. It is called by
// CapitalScan for a position with debt.
func (e *Engine) deleverage(ctx context.Context, w store.WalletRow, m execution.LendingMarketCfg) error {
	mrow, err := e.store.CapitalMandate(ctx, w.AgentID)
	if err != nil {
		return err
	}
	if mrow == nil || mrow.Status != "active" || !strings.EqualFold(mrow.MarketID, m.ID) {
		return nil
	}
	agent, err := e.store.GetAgent(ctx, w.AgentID)
	if err != nil {
		return err
	}
	if agent.Status != "active" && agent.Status != "paused" {
		return nil
	}
	mandate := mandateFrom(mrow)
	in, err := e.readCapitalInputs(ctx, w.AgentID, m.ID, mandate)
	if err != nil {
		return err
	}
	st := in.state
	if st.DebtUSDG <= 0 {
		return nil
	}
	hf := st.HealthAt(st.CollateralQty, st.DebtUSDG)
	if hf >= mandate.MinHealthFactor {
		return nil
	}
	plan := PlanDeleverage(mandate, st)
	if plan.Kind == "" {
		// Nothing can be done this scan. Said on the record, once per change of
		// reason, so a stuck position is visible rather than quiet.
		if plan.Why != "" {
			a := capital.Action{Kind: capital.Hold, Reason: "deleverage_stuck", Why: plan.Why}
			e.recordCapital(ctx, w.AgentID, in.market.ID, "deleverage", a,
				&CapitalOutcome{Kind: "hold", Status: "held", Reason: a.Reason}, in.ev)
		}
		return nil
	}
	in.ev["deleverage_step"] = plan.Step
	in.ev["health_factor_worst_before"] = hf

	lerr := e.store.AcquireLease(ctx, w.AgentID, leaseHolderDeleverage, LeaseTTL, "deleverage "+plan.Step)
	if errors.Is(lerr, store.ErrLeaseHeld) {
		// Another mover has the wallet; the next scan, a minute away, tries again.
		return nil
	}
	if lerr != nil {
		return fmt.Errorf("deleverage lease: %w", lerr)
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), w.AgentID, leaseHolderDeleverage); rerr != nil {
			log.Printf("agent %s: deleverage lease not released early, it will expire: %v", w.AgentID, rerr)
		}
	}()

	a := capital.Action{Kind: "deleverage", Amount: plan.Amount, Reason: "deleverage_" + plan.Step, Why: plan.Why}
	out := &CapitalOutcome{Kind: "deleverage", Amount: plan.Amount, Reason: a.Reason}
	switch plan.Kind {
	case "repay", "withdraw":
		r := e.broker.ExecuteCapital(ctx, w.AgentID, in.wallet, in.market, plan.Kind, plan.Amount)
		out.Status, out.RefusalCode, out.TxHash, out.ApproveTxHash = r.Status, r.RefusalCode, r.TxHash, r.ApproveTxHash
		if r.Status != execution.StatusMined {
			out.RefusalDetail = r.Note
		}
		in.ev["execution_note"] = r.Note
	case "sell":
		sym := in.market.CollateralToken
		if tok, terr := e.broker.TokenByAddress(in.market.CollateralToken); terr == nil {
			sym = tok.Symbol
		}
		res, xerr := e.broker.Execute(ctx, execution.Request{AgentID: w.AgentID, Wallet: in.wallet, Action: "sell",
			Symbol: sym, Qty: plan.Amount, Price: st.OraclePrice})
		if xerr != nil {
			out.Status, out.RefusalDetail = "blocked", xerr.Error()
		} else {
			out.Status, out.RefusalCode, out.TxHash = res.Status, res.RefusalCode, res.TxHash
			if res.Approve != nil {
				out.ApproveTxHash = res.Approve.TxHash
			}
			if res.Status != execution.StatusMined {
				out.RefusalDetail = res.Note
			}
			in.ev["execution_note"] = res.Note
		}
	}
	if out.Status == execution.StatusRefused && out.RefusalCode == "" {
		out.RefusalCode = "deleverage_refused"
	}
	// capital_actions records mined, reverted, unresolved, refused and
	// blocked. A swap whose quote failed sent nothing, which is blocked.
	if out.Status == execution.StatusQuoteFailed {
		out.Status = execution.StatusBlocked
	}
	e.recordCapital(ctx, w.AgentID, in.market.ID, "deleverage", a, out, in.ev)
	log.Printf("agent %s: deleverage %s %.6f -> %s (health factor %.3f, floor %.2f)",
		w.AgentID, plan.Step, plan.Amount, out.Status, hf, mandate.MinHealthFactor)
	return nil
}

// DeleveragePlan is one deleverage step.
type DeleveragePlan struct {
	Kind   string // repay | sell | withdraw; "" when nothing can be done
	Step   string
	Amount float64 // USDG for repay, collateral units otherwise
	Why    string
}

// PlanDeleverage chooses the step. Pure, so it is tested without a chain.
func PlanDeleverage(m capital.Mandate, s capital.State) DeleveragePlan {
	price := s.PoolPrice
	if price <= 0 || (s.OraclePrice > 0 && s.OraclePrice < price) {
		price = s.OraclePrice
	}
	if price <= 0 || s.LLTV <= 0 || s.DebtUSDG <= 0 {
		return DeleveragePlan{}
	}
	hf := s.CollateralQty * price * s.LLTV / s.DebtUSDG
	target := s.CollateralQty * price * s.LLTV / (m.MinHealthFactor * deleverageTargetMargin)
	need := s.DebtUSDG - target
	if need <= 0 {
		return DeleveragePlan{}
	}
	head := fmt.Sprintf("worst-case health factor %.3f is under the mandate's floor %.2f; %.2f USDG of debt must go",
		hf, m.MinHealthFactor, need)

	if s.WalletUSDG >= 0.01 {
		amt := math.Min(need, math.Min(s.WalletUSDG, s.DebtUSDG))
		return DeleveragePlan{"repay", "repay", amt, head + fmt.Sprintf("; repaying %.2f from the wallet", amt)}
	}
	if s.WalletCollateral > 0 {
		qty := math.Min(s.WalletCollateral, need/price*sellSlippage)
		return DeleveragePlan{"sell", "sell", qty, head + fmt.Sprintf(
			"; selling %.6f of the collateral token the wallet holds to repay with", qty)}
	}
	// Take collateral back, but never below withdrawSafety.
	keep := s.DebtUSDG * withdrawSafety / (price * s.LLTV)
	room := s.CollateralQty - keep
	if room <= 0 {
		return DeleveragePlan{Why: head + "; nothing in the wallet to repay or sell, and no collateral can come back " +
			"without taking the position under the withdrawal safety line"}
	}
	qty := math.Min(room, need/price*sellSlippage)
	return DeleveragePlan{"withdraw", "withdraw", qty, head + fmt.Sprintf(
		"; nothing in the wallet, so taking %.6f of the collateral back to sell on the next scan", qty)}
}
