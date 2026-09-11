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
) (settlement, error) {

	// 1. WHAT IS ACTUALLY THERE, before anything is attempted. One reading,
	//    used for both the reconciliation and the snapshot.
	before, err := e.broker.Read(ctx, wallet.Address)
	if err != nil {
		return settlement{Ev: ev}, fmt.Errorf("read on-chain position: %w", err)
	}

	// 2. Does it agree with what ARCANA last wrote down? This is the check that
	//    was meaningless while nothing was recorded. It compares a claim to a
	//    fact, and only when a claim exists.
	e.noteDrift(ctx, req.AgentID, portfolioID, recordedHoldings, recordedCash, before, wallet)

	holdings := toAnyMap(before.Holdings)

	if intent.Action != "buy" && intent.Action != "sell" {
		return settlement{Action: "hold", Holdings: holdings, Cash: before.Cash, Rationale: intent.Rationale, Ev: ev}, nil
	}

	price := prices[intent.Symbol]
	res, err := e.broker.Execute(ctx, execution.Request{
		AgentID: req.AgentID, Wallet: wallet.Address,
		Action: intent.Action, Symbol: intent.Symbol, Qty: intent.Quantity, Price: price,
		ExactUnitsIn: e.exitUnits(intent, before),
	})
	if err != nil {
		return settlement{Ev: ev}, fmt.Errorf("execute: %w", err)
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
		FeeTier: res.FeeTier, PoolFeeUnits: res.PoolFeeUnits,
		PoolFeeUSD: res.PoolFeeUSD, GasCostUSD: res.GasCostUSD, EthUSD: res.EthUSD,
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

	// THE APPROVAL GETS ITS OWN ROW. It is its own transaction: its own hash,
	// its own nonce, its own gas bill. Folding it into the swap lost 26% of one
	// agent gas spend with no row anywhere to find it in.
	//
	// filled_out stays NULL: an approval moves nothing BY DESIGN, which is a
	// different fact from a swap that moved nothing, and zero would conflate them.
	if ap := res.Approve; ap != nil {
		if _, aerr := e.store.AppendExecution(wctx, store.ExecutionInsert{
			AgentID: req.AgentID, DecisionID: nil, TS: req.Timestamp,
			IntentAction: "approve", Symbol: res.Symbol,
			TokenIn: ap.Token, TokenOut: ap.Token,
			AmountIn: ap.Amount,
			TxHash: ap.TxHash, GasUsed: ap.GasUsed,
			GasPriceWei: ap.GasPriceWei, GasCostWei: ap.GasCostWei,
			GasCostUSD: ap.GasCostUSD, EthUSD: ap.EthUSD,
			Status: ap.Status, Note: ap.Note,
		}); aerr != nil {
			log.Printf("ERROR agent %s: the approval %s was broadcast and its cost was not recorded: %v",
				req.AgentID, ap.TxHash, aerr)
		}
	}

	// 4. Read the position again. Whatever happened — filled, reverted, never
	//    mined — this is what the agent holds now.
	after, err := e.broker.Read(ctx, wallet.Address)
	if err != nil {
		return settlement{Ev: ev}, fmt.Errorf("read on-chain position after execution: %w", err)
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
			return settlement{Action: ActionTradeFailed, Symbol: res.Symbol, Holdings: holdings, Cash: afterCash, Rationale: rationale, ExecID: execPtr, Ev: ev}, nil
		}
		shares := e.sharesTraded(res)
		s := settlement{Action: res.IntentAction, Symbol: res.Symbol, Qty: &shares,
			Holdings: holdings, Cash: afterCash, Rationale: rationale, ExecID: execPtr, Ev: ev}

		switch res.IntentAction {
		case "buy":
			// THE ENTRY PRICE IS MEASURED, not quoted. Quote units actually
			// spent divided by shares actually received, so a level set "5%
			// below entry" is 5% below what the agent really paid — pool fee,
			// slippage and all. Anchoring a stop to the price on the snapshot
			// would put it 5% below a number that never existed.
			fill := e.filledPrice(res)

			// A TOP-UP IS A SECOND ENTRY, and "what you paid" then means the
			// average across both. Anchoring the new levels to the latest fill
			// alone would move an existing stop every time the agent added to a
			// winner, which is the opposite of what a stop is for.
			//
			// Shares bought before any guard existed have no cost basis this
			// system can see. Those are counted into the covered quantity and
			// NAMED in the note, rather than silently priced at the new fill.
			entry, qty, basis := e.blendEntry(ctx, req.AgentID, res.Symbol, fill, shares, before)

			lv := resolveGuardLevels(intent.Guards, entry, e.broker.PoolFeeOf(res.Symbol))
			if lv.any() || len(lv.Refusals) > 0 {
				s.Rationale += guardSummary(lv, entry) + basis
			}
			if lv.any() {
				s.Guard = &pendingGuard{
					Symbol: res.Symbol, EntryPrice: entry, EntryQty: qty, Levels: lv, Basis: basis,
				}
			} else if lv.Asked() {
				// ASKED FOR AND NOT GIVEN. The position is open and unprotected,
				// and that is now a row rather than a sentence in a rationale.
				s.RefusedGuard = &pendingGuard{
					Symbol: res.Symbol, EntryPrice: entry, EntryQty: qty, Levels: lv, Basis: basis,
				}
			}
		case "sell":
			// The position left by the agent's own decision, so anything armed
			// on it is no longer guarding a position. Cleared rather than left
			// armed: a guard over nothing would fire on the next price tick and
			// spend gas discovering that there is nothing to sell.
			s.ClearGuard = res.Symbol
		}
		return s, nil

	case execution.StatusUnresolved:
		// NEITHER SUCCESS NOR NON-EVENT. The holdings above are the chain as it
		// stands, which is the only honest thing to record, and the execution
		// row keeps the hash so the outcome can be settled later.
		return settlement{Action: ActionTradeUnresolved, Symbol: res.Symbol, Holdings: holdings, Cash: afterCash, Rationale: rationale, ExecID: execPtr, Ev: ev}, nil

	default:
		// reverted, refused, quote_failed, blocked. The agent tried and no
		// position resulted.
		return settlement{Action: ActionTradeFailed, Symbol: res.Symbol, Holdings: holdings, Cash: afterCash, Rationale: rationale, ExecID: execPtr, Ev: ev}, nil
	}
}

// settlement is everything one on-chain attempt produced.
//
// A STRUCT RATHER THAN NINE RETURN VALUES, which is what this was. The protective
// exit path needs the same shape, and two functions returning nine positional
// values in the same order is a bug waiting for someone to reorder one of them.
type settlement struct {
	Action    string
	Symbol    string
	Qty       *float64
	Holdings  map[string]any
	Cash      float64
	Rationale string
	ExecID    *int64
	Ev        Evidence

	// Guard is a protective level to arm, once the decision it belongs to has
	// an id. Nil when nothing was asked for or nothing was allowed.
	Guard *pendingGuard
	// ClearGuard names a symbol whose armed guard no longer guards anything,
	// because the agent exited the position by its own decision.
	ClearGuard string
	// RefusedGuard is a position whose owner ASKED for protection and did not
	// get it. Recorded as a state rather than left in the rationale, because an
	// owner who wrote a stop loss into their prompt will otherwise believe they
	// have one.
	RefusedGuard *pendingGuard
}

// pendingGuard is a guard waiting for its decision id.
type pendingGuard struct {
	Symbol     string
	EntryPrice float64
	EntryQty   float64
	Levels     armedLevels
	// Basis records how the entry price was arrived at when it was not simply
	// this fill: an average across two entries, or shares whose cost this
	// system never saw.
	Basis string
}

// blendEntry works out what the agent has paid for the position the new guard
// will cover, and says plainly when part of it is unknown.
//
// Three cases, and the third is the one worth being careful about:
//
//	no prior shares       the fill is the whole story
//	a guard already armed its entry price and quantity are ARCANA's own
//	                      record of what the earlier shares cost, so the two
//	                      entries are volume-weighted
//	prior shares, no guard the agent held something this system never priced —
//	                      bought before guards existed, or transferred in. The
//	                      shares are covered (the exit sells the whole balance
//	                      either way) and the note says their cost is unknown,
//	                      because a stop that silently prices them at today's
//	                      fill would claim a cost basis nobody measured.
func (e *Engine) blendEntry(ctx context.Context, agentID, symbol string, fill, bought float64,
	before *execution.Position) (entry, covered float64, basis string) {

	prior := 0.0
	if before != nil {
		prior = unitsToShares(before.Units[symbol], e.broker.DecimalsOf(symbol))
	}
	if prior < DustFloor {
		return fill, bought, ""
	}

	g, err := e.store.ArmedGuardFor(ctx, agentID, symbol)
	if err != nil {
		log.Printf("agent %s: could not read the existing guard on %s, pricing from this fill only: %v",
			agentID, symbol, err)
	}
	if g != nil && g.EntryQty > 0 && g.EntryPrice > 0 {
		covered = g.EntryQty + bought
		entry = (g.EntryQty*g.EntryPrice + bought*fill) / covered
		return entry, covered, fmt.Sprintf(
			" | levels measured from the average of both entries: %.8f at %.6f and %.8f at %.6f",
			g.EntryQty, g.EntryPrice, bought, fill)
	}

	return fill, prior + bought, fmt.Sprintf(
		" | note: %.8f %s was already held with no cost basis on record, so the levels are "+
			"measured from the %.8f bought now at %.6f; the exit will sell the whole position",
		prior, symbol, bought, fill)
}

// filledPrice is what a buy actually paid per share.
//
// Both sides come from the execution: quote units sent, share units received.
// Returns 0 when either is missing, and resolveGuardLevels refuses to arm
// anything against a zero rather than inventing a level.
func (e *Engine) filledPrice(res *execution.Result) float64 {
	if res.AmountIn == nil || res.Filled == nil || res.Filled.Sign() <= 0 {
		return 0
	}
	spent := unitsToShares(res.AmountIn, e.broker.QuoteDecimals())
	got := unitsToShares(res.Filled, e.broker.DecimalsOf(res.Symbol))
	if got <= 0 {
		return 0
	}
	return spent / got
}

// exitUnits decides whether this sell is an EXIT, and if so returns the exact
// integer balance to send.
//
// THE TEST IS WHETHER THE REMAINDER COULD BE RECORDED. If selling the requested
// quantity would leave less than DustFloor behind, the remainder is not a
// position the agent could ever act on again — it is a residue. The honest
// thing is not to leave it and then teach every reader to ignore it: it is to
// send the balance, as the integer the chain holds it as, so the position
// actually closes.
//
// That is also the only construction immune to the bug that produced the
// residue in the first place. The requested quantity arrives here as a float64
// and cannot express an eighteen-decimal balance exactly; the balance can only
// be emptied by an amount that was never a float.
//
// Returns nil for a partial sell, which is left to go through the ordinary
// float conversion — a partial sell is not trying to reach zero.
func (e *Engine) exitUnits(intent tradeIntent, before *execution.Position) *big.Int {
	if intent.Action != "sell" || before == nil {
		return nil
	}
	return exitAmount(before.Units[intent.Symbol], intent.Quantity, e.broker.DecimalsOf(intent.Symbol))
}

// exitAmount is the arithmetic, separated from the plumbing so it can be driven
// with the balance that actually caused the problem rather than inferred from a
// reading of the branches.
func exitAmount(have *big.Int, wantShares float64, decimals int) *big.Int {
	if have == nil || have.Sign() <= 0 {
		return nil
	}
	want := toUnits(wantShares, decimals)
	if want.Cmp(have) > 0 {
		// Asking for more than is there. Sending the balance is both what the
		// intent meant and the only amount that will not simply revert.
		return new(big.Int).Set(have)
	}
	if new(big.Int).Sub(have, want).Cmp(dustUnits(decimals)) < 0 {
		return new(big.Int).Set(have)
	}
	return nil
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

// toAnyMap turns a chain reading into the shape a snapshot is written in, and
// DROPS DUST on the way.
//
// Cleaning at the write is what keeps new rows free of entries no reader should
// have to defend itself against. It does not replace the readers defending
// themselves: rows written before this existed are still in the table, and they
// have to stay comparable with the rows written after it.
func toAnyMap(in map[string]float64) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if v >= DustFloor {
			out[k] = v
		}
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
