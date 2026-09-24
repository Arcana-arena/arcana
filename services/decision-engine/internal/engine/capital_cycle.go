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

// CapitalOutcome is what one capital action did.
type CapitalOutcome struct {
	Kind          string  `json:"kind"`
	Amount        float64 `json:"amount"`
	Status        string  `json:"status"`
	Reason        string  `json:"reason"`
	RefusalCode   string  `json:"refusal_code,omitempty"`
	RefusalDetail string  `json:"refusal_detail,omitempty"`
	TxHash        string  `json:"tx_hash,omitempty"`
	ApproveTxHash string  `json:"approve_tx_hash,omitempty"`
}

// capitalInputs is everything one capital action is decided and validated on,
// read once, in one place, for the mandate's cycle and the owner's hand alike.
type capitalInputs struct {
	wallet string
	market execution.LendingMarketCfg
	state  capital.State
	ev     map[string]any
}

func (e *Engine) readCapitalInputs(ctx context.Context, agentID, marketID string, mandate capital.Mandate) (*capitalInputs, error) {
	w, err := e.store.ChainWalletFor(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, fmt.Errorf("the agent has no chain wallet")
	}
	var market *execution.LendingMarketCfg
	for _, m := range e.broker.CapitalMarkets() {
		if marketID == "" || strings.EqualFold(m.ID, marketID) {
			m := m
			market = &m
			break
		}
	}
	if market == nil {
		return nil, fmt.Errorf("market %s is not in the lending allowlist", marketID)
	}

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
	return &capitalInputs{wallet: w.Address, market: *market, state: st, ev: ev}, nil
}

func mandateFrom(m *store.CapitalMandateRow) capital.Mandate {
	return capital.Mandate{
		MinHealthFactor: m.MinHealthFactor, MaxBorrowRateBps: m.MaxBorrowRateBps,
		LiquidityTriggerUSDG: m.LiquidityTriggerUSDG, MaxBorrowUSDG: m.MaxBorrowUSDG,
		NeverSell: m.NeverSell,
	}
}

// recordCapital writes one capital_actions row. A hold that repeats the
// agent's previous row is not written.
func (e *Engine) recordCapital(ctx context.Context, agentID, marketID, decider string, a capital.Action,
	out *CapitalOutcome, ev map[string]any) *CapitalOutcome {
	if a.Kind == capital.Hold {
		if k, reason, _ := e.store.LastCapitalReason(ctx, agentID); k == "hold" && reason == a.Reason {
			return out
		}
	}
	row := store.CapitalActionRow{
		AgentID: agentID, MarketID: marketID, Decider: decider, Kind: string(a.Kind),
		Amount: a.Amount, ReasonCode: a.Reason, Why: a.Why, Evidence: ev, Status: out.Status,
		RefusalCode: out.RefusalCode, RefusalDetail: out.RefusalDetail,
		TxHash: out.TxHash, ApproveTxHash: out.ApproveTxHash,
	}
	if _, err := e.store.InsertCapitalAction(context.WithoutCancel(ctx), row); err != nil {
		log.Printf("agent %s: capital action NOT RECORDED: %v", agentID, err)
	}
	return out
}

// actCapital validates, takes the lease, executes and records one action.
// Validate runs here for every caller, so no path can reach the signer without it.
func (e *Engine) actCapital(ctx context.Context, agentID, decider string, a capital.Action, m capital.Mandate, in *capitalInputs) *CapitalOutcome {
	out := &CapitalOutcome{Kind: string(a.Kind), Amount: a.Amount, Reason: a.Reason}
	refused := func(code, detail string) *CapitalOutcome {
		out.Status, out.RefusalCode, out.RefusalDetail = "refused", code, detail
		return e.recordCapital(ctx, agentID, in.market.ID, decider, a, out, in.ev)
	}
	if ref := capital.Validate(a, m, in.state); ref != nil {
		return refused(ref.Code, ref.Detail)
	}

	// One mover at a time: the trading cycle, the guard, the mandate and the
	// owner all take the same lease.
	lerr := e.store.AcquireLease(ctx, agentID, leaseHolderCycle, LeaseTTL, "capital "+string(a.Kind))
	if errors.Is(lerr, store.ErrLeaseHeld) {
		return refused(ReasonPositionLocked, "another actor holds this wallet's execution lease; try again in a moment")
	}
	if lerr != nil {
		return refused(ReasonPositionLocked, "the execution lease could not be read: "+lerr.Error())
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), agentID, leaseHolderCycle); rerr != nil {
			log.Printf("agent %s: capital lease not released early, it will expire: %v", agentID, rerr)
		}
	}()

	r := e.broker.ExecuteCapital(ctx, agentID, in.wallet, in.market, string(a.Kind), a.Amount)
	out.TxHash, out.ApproveTxHash = r.TxHash, r.ApproveTxHash
	if r.Status == execution.StatusRefused {
		return refused(r.RefusalCode, r.Note)
	}
	out.Status, out.RefusalCode = r.Status, r.RefusalCode
	if r.Status != execution.StatusMined {
		out.RefusalDetail = r.Note
	}
	in.ev["execution_note"] = r.Note
	return e.recordCapital(ctx, agentID, in.market.ID, decider, a, out, in.ev)
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
	mandate := mandateFrom(mrow)

	in, err := e.readCapitalInputs(ctx, agentID, mrow.MarketID, mandate)
	if err != nil {
		if strings.Contains(err.Error(), "not in the lending allowlist") {
			a := capital.Action{Kind: capital.Hold, Reason: "market_not_allowlisted", Why: err.Error()}
			out := &CapitalOutcome{Kind: "hold", Status: "held", Reason: a.Reason}
			return e.recordCapital(ctx, agentID, mrow.MarketID, "deterministic", a, out, map[string]any{"mandate": mandate}), nil
		}
		return nil, err
	}

	a := capital.Decide(mandate, in.state)
	if a.Kind == capital.Hold {
		out := &CapitalOutcome{Kind: "hold", Status: "held", Reason: a.Reason}
		return e.recordCapital(ctx, agentID, in.market.ID, "deterministic", a, out, in.ev), nil
	}
	return e.actCapital(ctx, agentID, "deterministic", a, mandate, in), nil
}

// OwnerFloor is the health-factor floor applied to an owner's manual borrow
// when the agent has no mandate: the same minimum a mandate may set.
const OwnerFloor = 1.5

// CapitalManual carries out one supply, borrow or repay the OWNER asked for.
//
// THE SAME RULE AS THE MANDATE. The owner chooses the amount; they do not get
// past capital.Validate, the platform's caps or the signer. With a mandate, its
// floor, cap and rate apply; without one, the platform's cap and a floor of
// 1.5. A retired agent may still repay, and nothing else.
//
// Recorded in capital_actions with decider "owner", beside the mandate's own
// rows, so the page shows who moved what.
func (e *Engine) CapitalManual(ctx context.Context, agentID, kind string, amount float64) (*CapitalOutcome, error) {
	if e.broker == nil {
		return nil, fmt.Errorf("chain execution is not configured")
	}
	agent, err := e.store.GetAgent(ctx, agentID)
	if err != nil {
		return nil, err
	}
	a := capital.Action{Kind: capital.Kind(kind), Amount: amount, Reason: "owner_request",
		Why: fmt.Sprintf("the owner asked to %s %g", kind, amount)}
	if agent.Status == "retired" && a.Kind != capital.Repay {
		return &CapitalOutcome{Kind: kind, Amount: amount, Status: "refused", Reason: a.Reason,
			RefusalCode: "agent_retired", RefusalDetail: "a retired agent may repay its debt, and nothing else"}, nil
	}

	mrow, err := e.store.CapitalMandate(ctx, agentID)
	if err != nil {
		return nil, err
	}
	_, perAgent := e.broker.PlatformCaps()
	mandate := capital.Mandate{MinHealthFactor: OwnerFloor, MaxBorrowRateBps: 10000, MaxBorrowUSDG: perAgent}
	marketID := ""
	if mrow != nil {
		mandate, marketID = mandateFrom(mrow), mrow.MarketID
	}
	in, err := e.readCapitalInputs(ctx, agentID, marketID, mandate)
	if err != nil {
		return nil, err
	}
	in.ev["requested_by"] = "owner"
	return e.actCapital(ctx, agentID, "owner", a, mandate, in), nil
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
