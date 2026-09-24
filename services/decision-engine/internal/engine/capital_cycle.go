package engine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/arcana/decision-engine/internal/capital"
	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// oracleMaxAge is the Chainlink heartbeat of the feeds behind the allowlisted
// market (86 400 s, docs/go-no-go-lending.md) plus an hour of slack. Older
// than this, or unreadable, and no borrow is proposed.
const oracleMaxAge = 86400 + 3600

// CapitalOutcome is what one capital cycle did, for the caller's log line.
type CapitalOutcome struct {
	Kind, Status, Reason string
}

// CapitalCycle runs the agent's capital mandate once: read the position,
// decide, VALIDATE, execute, record. It runs after the trading cycle has
// released its lease, on the same cadence, for ACTIVE agents only — a paused
// agent stops borrowing (§17.4); its position is still read by the guard.
//
// Every action and every refusal is written to capital_actions with the inputs
// it was taken on. A hold is written only when its reason differs from the
// agent's previous row.
func (e *Engine) CapitalCycle(ctx context.Context, agentID string) (*CapitalOutcome, error) {
	if e.broker == nil {
		return nil, nil
	}
	mrow, err := e.store.CapitalMandate(ctx, agentID)
	if err != nil || mrow == nil || mrow.Status != "active" {
		return nil, err
	}
	agent, err := e.store.GetAgent(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if agent.Status != "active" {
		return nil, nil
	}
	w, err := e.store.ChainWalletFor(ctx, agentID)
	if err != nil || w == nil {
		return nil, err
	}

	var market *execution.LendingMarketCfg
	for _, m := range e.broker.CapitalMarkets() {
		if strings.EqualFold(m.ID, mrow.MarketID) {
			m := m
			market = &m
		}
	}
	mandate := capital.Mandate{
		MinHealthFactor: mrow.MinHealthFactor, MaxBorrowRateBps: mrow.MaxBorrowRateBps,
		LiquidityTriggerUSDG: mrow.LiquidityTriggerUSDG, MaxBorrowUSDG: mrow.MaxBorrowUSDG,
		NeverSell: mrow.NeverSell,
	}
	record := func(a capital.Action, status, refCode, refDetail string, ev map[string]any, r *execution.CapitalResult) *CapitalOutcome {
		row := store.CapitalActionRow{
			AgentID: agentID, MarketID: mrow.MarketID, Decider: "deterministic", Kind: string(a.Kind),
			Amount: a.Amount, ReasonCode: a.Reason, Why: a.Why, Evidence: ev, Status: status,
			RefusalCode: refCode, RefusalDetail: refDetail,
		}
		if r != nil {
			row.TxHash, row.ApproveTxHash = r.TxHash, r.ApproveTxHash
		}
		if a.Kind == capital.Hold {
			if k, reason, _ := e.store.LastCapitalReason(ctx, agentID); k == "hold" && reason == a.Reason {
				return &CapitalOutcome{string(a.Kind), status, a.Reason}
			}
		}
		if _, err := e.store.InsertCapitalAction(context.WithoutCancel(ctx), row); err != nil {
			log.Printf("agent %s: capital action NOT RECORDED: %v", agentID, err)
		}
		return &CapitalOutcome{string(a.Kind), status, a.Reason}
	}
	if market == nil {
		a := capital.Action{Kind: capital.Hold, Reason: "market_not_allowlisted",
			Why: "the mandate names market " + mrow.MarketID + ", which the allowlist no longer lists"}
		return record(a, "held", "", "", map[string]any{"mandate": mandate}, nil), nil
	}

	// --- the inputs, read now ------------------------------------------------
	now := time.Now()
	pos, err := e.broker.ReadPosition(ctx, *market, w.Address)
	if err != nil {
		return nil, fmt.Errorf("capital: %w", err)
	}
	ms, err := e.broker.ReadMarketState(ctx, *market, now)
	if err != nil {
		return nil, fmt.Errorf("capital: %w", err)
	}
	walletColl, walletUSDG, err := e.broker.WalletBalances(ctx, w.Address, *market)
	if err != nil {
		return nil, fmt.Errorf("capital: %w", err)
	}
	v := execution.Value(pos, ms)
	perTx, perAgent := e.broker.PlatformCaps()
	st := capital.State{
		CollateralQty: v.CollateralQty, DebtUSDG: v.Debt, LLTV: v.LLTV, OraclePrice: v.OraclePrice,
		WalletCollateral: walletColl, WalletUSDG: walletUSDG,
		BorrowRateBps:       ms.BorrowRateBps,
		AvailableUSDG:       execution.ToWhole(ms.TotalSupplyAssets, ms.LoanDec) - execution.ToWhole(ms.TotalBorrowAssets, ms.LoanDec),
		PlatformDebtCapUSDG: perAgent, PlatformTxCapUSDG: perTx,
	}
	if v.PoolPrice != nil {
		st.PoolPrice = *v.PoolPrice
	}
	if ms.BorrowRateBps < 0 {
		// Unreadable rate: above any mandate, so nothing is borrowed on it.
		st.BorrowRateBps = 1e9
	}
	var why []string
	switch {
	case ms.BaseFeedAge == nil || ms.QuoteFeedAge == nil:
		why = append(why, "a Chainlink feed behind the oracle could not be read")
	default:
		if *ms.BaseFeedAge > oracleMaxAge {
			why = append(why, fmt.Sprintf("the collateral feed is %d s old, past its heartbeat", *ms.BaseFeedAge))
		}
		if *ms.QuoteFeedAge > oracleMaxAge {
			why = append(why, fmt.Sprintf("the USDG feed is %d s old, past its heartbeat", *ms.QuoteFeedAge))
		}
	}
	if ms.OraclePaused == nil {
		why = append(why, "the token's oraclePaused() could not be read")
	} else if *ms.OraclePaused {
		why = append(why, "the issuer has paused the token's oracle for a corporate action")
	}
	if len(why) > 0 {
		st.OracleUntrusted, st.OracleWhy = true, strings.Join(why, "; ")
	}
	ev := map[string]any{"mandate": mandate, "state": st, "health_factor": v.HealthFactor,
		"health_factor_worst": v.HealthFactorWorst, "lending_enabled": e.broker.LendingEnabled()}

	// --- decide, then the rule that holds whatever decided -------------------
	a := capital.Decide(mandate, st)
	if a.Kind == capital.Hold {
		return record(a, "held", "", "", ev, nil), nil
	}
	if ref := capital.Validate(a, mandate, st); ref != nil {
		return record(a, "refused", ref.Code, ref.Detail, ev, nil), nil
	}

	// --- one mover at a time --------------------------------------------------
	lerr := e.store.AcquireLease(ctx, agentID, leaseHolderCycle, LeaseTTL, "capital "+string(a.Kind))
	if errors.Is(lerr, store.ErrLeaseHeld) {
		return record(a, "refused", ReasonPositionLocked, "another actor holds this wallet's execution lease", ev, nil), nil
	}
	if lerr != nil {
		return record(a, "refused", ReasonPositionLocked, "the execution lease could not be read: "+lerr.Error(), ev, nil), nil
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), agentID, leaseHolderCycle); rerr != nil {
			log.Printf("agent %s: capital lease not released early, it will expire: %v", agentID, rerr)
		}
	}()

	r := e.broker.ExecuteCapital(ctx, agentID, w.Address, *market, string(a.Kind), a.Amount)
	status := r.Status
	if status == execution.StatusRefused {
		return record(a, "refused", r.RefusalCode, r.Note, ev, r), nil
	}
	ev["execution_note"] = r.Note
	return record(a, status, r.RefusalCode, "", ev, r), nil
}

// neverSell converts a trading SELL of a never-sell symbol into a hold, when
// the agent has an active capital mandate that lists it. Applied after the
// decider answers, whoever the decider is.
func (e *Engine) neverSell(ctx context.Context, agentID string, intent tradeIntent) (tradeIntent, bool) {
	if intent.Action != "sell" {
		return intent, false
	}
	m, err := e.store.CapitalMandate(ctx, agentID)
	if err != nil {
		// Could not check is not the same as fine: a sell that might be of a
		// never-sell symbol waits for a tick that can read the list.
		return hold("stood down: the capital mandate could not be read (" + err.Error() +
			"), so whether this sell is allowed is unknown"), true
	}
	if m == nil || m.Status != "active" {
		return intent, false
	}
	if ref := capital.NeverSellRefusal(capital.Mandate{NeverSell: m.NeverSell}, "sell", strings.ToUpper(intent.Symbol)); ref != nil {
		return hold("refused: " + ref.Detail + "; the decider proposed selling it: " + intent.Rationale), true
	}
	return intent, false
}

// ReasonNeverSell is a trading SELL refused by the capital mandate's never-sell
// list. docs-verify requires every emitted reason code to be documented.
const ReasonNeverSell = "never_sell"
