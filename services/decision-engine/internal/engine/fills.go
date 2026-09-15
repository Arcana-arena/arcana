package engine

import (
	"context"
	"log"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// Recording fills (0051).
//
// EVERY PATH THAT CHANGES A BOOK CALLS writeFill: the virtual settlement, a
// human's manual trade, the creator's on-chain fill, the creator's protective
// exit, a subscriber's fan-out leg and a subscriber's protective exit. A path
// that forgot would leave a position with no cost basis again, which is the
// exact hole this closes.
//
// A FILL THAT CANNOT BE RECORDED DOES NOT UNDO THE TRADE. The trade has already
// happened — on chain it cannot be taken back — so the failure is logged at
// ERROR and the reconciliation in ApplyFill names the resulting gap on the next
// fill (shares whose cost is unknown) rather than inventing one.

// pendingFill is a fill waiting for the ids it will be recorded under.
type pendingFill struct {
	Symbol     string
	Side       string
	Qty        float64
	Price      float64
	GasUSD     *float64
	PoolFeeUSD *float64
	HeldBefore float64
}

// chainFillFrom reads a fill out of an execution result: quote units against
// share units, both as the chain moved them, so the price is what was paid net
// of the pool fee. Nil when nothing moved.
func (e *Engine) chainFillFrom(res *execution.Result, before *execution.Position) *pendingFill {
	if e.broker == nil || res == nil || !res.Moved() || (res.IntentAction != "buy" && res.IntentAction != "sell") {
		return nil
	}
	qd, sd := e.broker.QuoteDecimals(), e.broker.DecimalsOf(res.Symbol)
	var shares, quote float64
	if res.IntentAction == "buy" {
		quote, shares = unitsToShares(res.AmountIn, qd), unitsToShares(res.Filled, sd)
	} else {
		shares, quote = unitsToShares(res.AmountIn, sd), unitsToShares(res.Filled, qd)
	}
	if shares <= 0 || quote <= 0 {
		return nil
	}
	f := &pendingFill{Symbol: res.Symbol, Side: res.IntentAction, Qty: shares, Price: quote / shares}
	// UNPRICED GAS STAYS UNPRICED. A zero dollar figure means the ETH price
	// could not be read, and a fill recorded as free would flatter its trade.
	if res.GasCostUSD > 0 {
		g := res.GasCostUSD
		if res.Approve != nil {
			g += res.Approve.GasCostUSD
		}
		f.GasUSD = &g
	}
	if res.PoolFeeUSD > 0 {
		p := res.PoolFeeUSD
		f.PoolFeeUSD = &p
	}
	if before != nil {
		f.HeldBefore = unitsToShares(before.Units[res.Symbol], sd)
	}
	return f
}

// virtualFill is a settlement at the snapshot price: no chain, no gas.
func virtualFill(action, symbol string, qty *float64, prices map[string]float64, heldBefore float64) *pendingFill {
	if (action != "buy" && action != "sell") || qty == nil || *qty <= 0 {
		return nil
	}
	price, ok := prices[symbol]
	if !ok || price <= 0 {
		return nil
	}
	zero := 0.0
	return &pendingFill{Symbol: symbol, Side: action, Qty: *qty, Price: price, GasUSD: &zero, HeldBefore: heldBefore}
}

// writeFill records one fill with its accounting. Never fails the caller.
func (e *Engine) writeFill(ctx context.Context, agentID string, book store.FillBook,
	decisionID, executionID *int64, ts time.Time, source string, f *pendingFill) {
	if f == nil {
		return
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := e.store.RecordFill(wctx, store.FillInsert{
		TS: ts, AgentID: agentID, Book: book, DecisionID: decisionID, ExecutionID: executionID,
		Symbol: f.Symbol, Side: f.Side, Quantity: f.Qty, Price: f.Price,
		GasUSD: f.GasUSD, PoolFeeUSD: f.PoolFeeUSD, Source: source, HeldBefore: f.HeldBefore,
	}); err != nil {
		log.Printf("ERROR agent %s: %s %.8f %s at %.6f happened and the fill was NOT recorded, so its cost basis "+
			"is missing from the ledger: %v", agentID, f.Side, f.Qty, f.Symbol, f.Price, err)
	}
}
