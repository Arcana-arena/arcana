package engine

import (
	"context"
	"fmt"
	"log"
	"time"
	"math/big"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// Actions recorded when a trade was attempted and did not become a position.
//
// NEITHER OF THESE IS A HOLD. applyIntent used to turn an unsettleable trade
// into one, which was defensible while capital was virtual and the only failure
// was arithmetic. Once a transaction is broadcast the failures are different in
// kind: gas was spent, a nonce was consumed, and the agent tried. Recording
// that as "it chose to do nothing" is a lie the record cannot recover from,
// because nothing else in the row says a transaction ever existed.
//
// Downstream consumers filter explicitly on buy/sell/hold, so these values
// degrade the right way on their own: counted as a decision, never counted as
// a trade, never mistaken for a deliberate hold.
const (
	ActionTradeFailed     = "trade_failed"
	ActionTradeUnresolved = "trade_unresolved"
)

// OnChainQtyStep is the smallest quantity a chain-backed agent may trade.
//
// Set by what can be RECORDED, not by what the chain can carry: tokens divide
// to eighteen decimals, and decisions.quantity is numeric(20,8). Trading finer
// than this would write down a number that is not what happened.
const OnChainQtyStep = 1e-8

// settleOnChain runs one intent against real funds and reports what happened.
//
// It returns the values persist() needs, and the holdings and cash it returns
// are READ FROM THE CHAIN rather than derived. That is the whole point: the
// next decision is made from the same numbers the next transaction will be
// checked against, so the two can never quietly diverge.
func (e *Engine) settleOnChain(
	ctx context.Context,
	req ExecuteRequest,
	portfolioID string,
	wallet *store.ChainWallet,
	intent tradeIntent,
	prices map[string]float64,
	recordedHoldings map[string]any,
	recordedCash float64,
	ev Evidence,
) (string, string, *float64, map[string]any, float64, string, *int64, Evidence, error) {

	// 1. WHAT IS ACTUALLY THERE, before anything is attempted. One reading,
	//    used for both the reconciliation and the snapshot.
	before, err := e.broker.Read(ctx, wallet.Address)
	if err != nil {
		return "", "", nil, nil, 0, "", nil, ev, fmt.Errorf("read on-chain position: %w", err)
	}

	// 2. Does it agree with what ARCANA last wrote down? This is the check that
	//    was meaningless while nothing was recorded. It compares a claim to a
	//    fact, and only when a claim exists.
	e.noteDrift(ctx, req.AgentID, portfolioID, recordedHoldings, recordedCash, before, wallet)

	holdings := toAnyMap(before.Holdings)

	if intent.Action != "buy" && intent.Action != "sell" {
		return "hold", "", nil, holdings, before.Cash, intent.Rationale, nil, ev, nil
	}

	price := prices[intent.Symbol]
	res, err := e.broker.Execute(ctx, execution.Request{
		AgentID: req.AgentID, Wallet: wallet.Address,
		Action: intent.Action, Symbol: intent.Symbol, Qty: intent.Quantity, Price: price,
	})
	if err != nil {
		return "", "", nil, nil, 0, "", nil, ev, fmt.Errorf("execute: %w", err)
	}

	// 3. The row goes in BEFORE the decision, so a crash leaves an orphan that
	//    names a real transaction hash rather than a decision claiming a trade
	//    with nothing on chain to check it against.
	// The caller cannot cancel this write either. If a transaction was
	// broadcast, the row describing it must be written even when the request
	// that started the cycle has already given up.
	wctx, wrelease := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer wrelease()
	execID, err := e.store.AppendExecution(wctx, store.ExecutionInsert{
		AgentID: req.AgentID, TS: req.Timestamp,
		IntentAction: res.IntentAction, Symbol: res.Symbol,
		TokenIn: res.TokenIn, TokenOut: res.TokenOut,
		AmountIn: res.AmountIn, QuotedOut: res.QuotedOut, MinOut: res.MinOut,
		Filled: res.Filled, SlippageBps: res.SlippageBps,
		TxHash: res.TxHash, BlockNumber: res.BlockNumber,
		GasUsed: res.GasUsed, GasPriceWei: res.GasPriceWei, GasCostWei: res.GasCostWei,
		Status: res.Status, RefusalCode: res.RefusalCode, Note: res.Note,
	})
	if err != nil {
		// The transaction may already be on chain. Losing the decision on top
		// of losing the execution row would leave no trace of either.
		log.Printf("ERROR agent %s: execution %s could not be recorded: %v", req.AgentID, res.Status, err)
	}
	var execPtr *int64
	if execID != 0 {
		execPtr = &execID
	}

	// 4. Read the position again. Whatever happened — filled, reverted, never
	//    mined — this is what the agent holds now.
	after, err := e.broker.Read(ctx, wallet.Address)
	if err != nil {
		return "", "", nil, nil, 0, "", nil, ev, fmt.Errorf("read on-chain position after execution: %w", err)
	}
	holdings = toAnyMap(after.Holdings)
	afterCash := after.Cash

	ev.ReasonCode = "execution_" + res.Status
	rationale := intent.Rationale + " | " + executionSummary(res)

	switch res.Status {
	case execution.StatusMined:
		if !res.Moved() {
			// Mined, succeeded, and moved nothing measurable. Rare, and not a
			// trade: recording a position change here would invent one.
			return ActionTradeFailed, res.Symbol, nil, holdings, afterCash, rationale, execPtr, ev, nil
		}
		shares := e.sharesTraded(res)
		return res.IntentAction, res.Symbol, &shares, holdings, afterCash, rationale, execPtr, ev, nil

	case execution.StatusUnresolved:
		// NEITHER SUCCESS NOR NON-EVENT. The holdings above are the chain as it
		// stands, which is the only honest thing to record, and the execution
		// row keeps the hash so the outcome can be settled later.
		return ActionTradeUnresolved, res.Symbol, nil, holdings, afterCash, rationale, execPtr, ev, nil

	default:
		// reverted, refused, quote_failed, blocked. The agent tried and no
		// position resulted.
		return ActionTradeFailed, res.Symbol, nil, holdings, afterCash, rationale, execPtr, ev, nil
	}
}

// sharesTraded converts the chain amounts back into shares.
//
// For a BUY that is the fill, because the fill is what arrived. For a SELL it
// is the amount sent, because that is what left — the fill of a sell is dollars.
func (e *Engine) sharesTraded(res *execution.Result) float64 {
	dec := e.broker.DecimalsOf(res.Symbol)
	if res.IntentAction == "buy" {
		return unitsToShares(res.Filled, dec)
	}
	return unitsToShares(res.AmountIn, dec)
}

func unitsToShares(v *big.Int, decimals int) float64 {
	if v == nil {
		return 0
	}
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	f := new(big.Float).SetInt(v)
	f.Quo(f, scale)
	out, _ := f.Float64()
	return out
}

// executionSummary is the sentence that goes into the decision rationale, so
// the record says what happened without anyone having to join to another table.
func executionSummary(res *execution.Result) string {
	s := "execution " + res.Status
	if res.TxHash != "" {
		s += " tx=" + res.TxHash
	}
	if res.SlippageBps != nil {
		s += fmt.Sprintf(" slippage=%.2fbps", *res.SlippageBps)
	}
	if res.GasCostWei != nil {
		s += " gas_wei=" + res.GasCostWei.String()
	}
	if res.RefusalCode != "" {
		s += " refusal=" + res.RefusalCode
	}
	if res.Note != "" {
		s += " (" + res.Note + ")"
	}
	return s
}

func toAnyMap(in map[string]float64) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

// noteDrift compares what ARCANA recorded against what the wallet holds.
//
// IT IS NOT AN ERROR. For a wallet whose key the owner also holds, moving funds
// is something they are entitled to do, and halting on it would mean the
// platform stopping because a user used their own money. It is recorded because
// an unexplained balance change is the hardest thing to reconstruct afterwards,
// and this is the only moment both numbers exist in one place.
//
// It compares only when there is a prior snapshot. With nothing recorded there
// is no claim to disagree with, and reporting no drift from an absent record is
// exactly the unplugged-lamp reading this whole path exists to stop producing.
//
// EVERYTHING HERE IS IN BASE UNITS. custody_drift stores numeric(78,0) — whole
// token units — and the first version of this function wrote dollars and shares
// into it. Postgres rounded them to integers, so a wallet holding $9.79 was
// recorded as having expected 10, and a drift of 0.0061 AAPL was recorded as a
// drift of zero: rows that look like findings and carry no information. The
// chain side is integers to begin with, so the only conversion left is on the
// RECORDED side, and its error is bounded by the precision that side is stored
// at rather than by anything this function chooses.
func (e *Engine) noteDrift(
	ctx context.Context, agentID, portfolioID string,
	recorded map[string]any, recordedCash float64,
	pos *execution.Position,
	wallet *store.ChainWallet,
) {
	_, _, ok, _ := e.store.LastSnapshotHoldings(ctx, portfolioID)
	if !ok {
		log.Printf("agent %s: no prior snapshot, so there is nothing to reconcile against yet", agentID)
		return
	}

	chainUnits, chainCashUnits := pos.Units, pos.CashUnits

	note := "funds moved outside ARCANA"
	if wallet.KeyCustody == "shared" {
		note = "funds moved outside ARCANA; the owner holds this key too"
	}

	// Cash. portfolio_snapshots.cash is numeric(20,2), so a claim of "9.79" was
	// never a claim about the third decimal. The floor is half a cent: below it
	// the two agree as precisely as the record is capable of agreeing.
	qd := e.broker.QuoteDecimals()
	expectedCash := toUnits(recordedCash, qd)
	cashFloor := new(big.Int).Div(pow10(qd), big.NewInt(200))
	if differs(expectedCash, chainCashUnits, cashFloor) {
		e.writeDrift(ctx, agentID, "", "CASH", expectedCash, chainCashUnits, note)
	}

	// Holdings. These are stored as full-precision floats in jsonb, so the only
	// error is the float-to-integer conversion itself. The floor is a billionth
	// of a share: far above that error and far below any movement that matters.
	seen := map[string]bool{}
	for sym, v := range recorded {
		seen[sym] = true
		dec := e.broker.DecimalsOf(sym)
		expected := toUnits(toFloat(v), dec)
		observed := chainUnits[sym]
		if observed == nil {
			observed = big.NewInt(0)
		}
		if differs(expected, observed, floorFor(dec)) {
			e.writeDrift(ctx, agentID, e.broker.AddressOf(sym), sym, expected, observed, note)
		}
	}
	for sym, observed := range chainUnits {
		if seen[sym] || observed == nil || observed.Sign() == 0 {
			continue
		}
		dec := e.broker.DecimalsOf(sym)
		if differs(big.NewInt(0), observed, floorFor(dec)) {
			e.writeDrift(ctx, agentID, e.broker.AddressOf(sym), sym, big.NewInt(0), observed, note)
		}
	}
}

func pow10(n int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}

// floorFor is a billionth of one token, in that token's base units.
func floorFor(decimals int) *big.Int {
	if decimals <= 9 {
		return big.NewInt(1)
	}
	return pow10(decimals - 9)
}

// toUnits converts a recorded human figure into base units.
func toUnits(v float64, decimals int) *big.Int {
	f := new(big.Float).SetFloat64(v)
	f.Mul(f, new(big.Float).SetInt(pow10(decimals)))
	out, _ := f.Int(nil)
	return out
}

// differs reports whether two integer balances disagree by more than floor.
func differs(a, b, floor *big.Int) bool {
	d := new(big.Int).Sub(a, b)
	d.Abs(d)
	return d.Cmp(floor) > 0
}

func (e *Engine) writeDrift(ctx context.Context, agentID, token, symbol string, expected, observed *big.Int, note string) {
	delta := new(big.Int).Sub(observed, expected)
	if err := e.store.RecordCustodyDrift(ctx, agentID, token, symbol,
		expected.String(), observed.String(), delta.String(), "reconciled", note); err != nil {
		log.Printf("ERROR agent %s: custody drift on %s could not be recorded: %v", agentID, symbol, err)
		return
	}
	log.Printf("custody drift agent=%s %s expected=%s observed=%s delta=%s base units",
		agentID, symbol, expected, observed, delta)
}
