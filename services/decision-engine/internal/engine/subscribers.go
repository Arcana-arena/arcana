package engine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/big"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// One decision, several wallets.
//
// WHAT A SUBSCRIPTION BUYS. The agent's decisions executed against the buyer's
// own money for thirty days. Not a copy of the agent — there is still one
// agent, it still belongs to its creator, and this is the same decision reaching
// more accounts.
//
// THREE THINGS THAT DO NOT CHANGE, and they are the design:
//
//	THE DECISION IS SINGULAR. One tick, one model call, one row in `decisions`,
//	belonging to the agent. Nothing a subscriber does changes the agent's score,
//	DNA or Autopsy — an agent whose number moved because it gained customers
//	would be measuring its sales rather than its trading.
//
//	THE SIZE IS NOT. The creator chooses the direction; the buyer chooses how
//	much is at stake. Each wallet resolves the intent against its OWN capital
//	under its OWN limits. A creator who set trade_size_pct 0.5 for an $11 book
//	does not get to commit half of a $50,000 one.
//
//	EVERY WALLET IS ON ITS OWN. Out of gas, short of cash, blocked by the
//	issuer, refused by the signer — each is that wallet's outcome, recorded
//	against that wallet, and no other wallet hears about it. Same shape as one
//	expensive agent not silencing its neighbour.
//
// GAS IS EACH WALLET'S OWN. The broker's existing reserve check refuses to sign
// for a wallet that cannot pay for its own transaction, so a subscriber who has
// not funded theirs gets a recorded refusal rather than somebody else's ETH.

// SubscriberOutcome is what happened in one buyer's wallet, for the log and for
// the counters. Never an error return: a failure here is that subscriber's
// result, not the tick's.
type SubscriberOutcome struct {
	SubscriptionID string
	Wallet         string
	Status         string
	Note           string
}

// tradeForSubscribers executes the agent's intent in every subscriber's wallet.
//
// Called AFTER the creator's leg has settled and the decision has been
// persisted, so every execution row can name the decision it came from. The
// creator's execution is never held up by a subscriber's, and a subscriber's
// failure never reaches the creator.
func (e *Engine) tradeForSubscribers(
	ctx context.Context, req ExecuteRequest, decisionID int64,
	intent tradeIntent, prices map[string]float64,
) []SubscriberOutcome {

	if e.broker == nil || (intent.Action != "buy" && intent.Action != "sell") {
		return nil
	}
	subs, err := e.store.TradingSubscriptionsFor(ctx, req.AgentID)
	if err != nil {
		// READ FAILURE IS NOT AN EMPTY LIST. Trading for nobody because the
		// subscriber list could not be read is a silent breach of what was sold,
		// so it is logged at ERROR rather than passed over.
		log.Printf("ERROR agent %s: subscriber list unreadable, NOBODY was traded for this tick: %v",
			req.AgentID, err)
		return nil
	}
	if len(subs) == 0 {
		return nil
	}

	log.Printf("agent %s: decision %d reaches %d subscriber wallet(s)", req.AgentID, decisionID, len(subs))
	out := make([]SubscriberOutcome, 0, len(subs))
	for _, sub := range subs {
		// EACH ONE IN ITS OWN SCOPE, and the context is detached from the
		// caller's deadline for the same reason the creator's leg is: once a
		// transaction is broadcast, the row describing it must be written even
		// if the request that started the tick has given up.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Minute)
		res := e.tradeForOne(sctx, req, decisionID, intent, prices, sub)
		cancel()
		out = append(out, res)
		log.Printf("agent %s: subscription %s (%s) -> %s (%s)",
			req.AgentID, sub.ID, sub.Wallet, res.Status, res.Note)
	}
	return out
}

// tradeForOne is one buyer's wallet, start to finish.
//
// It goes through the SAME broker as the creator's leg: the same signer, the
// same allowlist, the same separate approval row, the same fill measured as a
// balance delta, the same receipt read back. Nothing about this path is a
// shortcut, because a shortcut is where the two would drift.
func (e *Engine) tradeForOne(
	ctx context.Context, req ExecuteRequest, decisionID int64,
	intent tradeIntent, prices map[string]float64, sub store.TradingSubscription,
) SubscriberOutcome {

	res := SubscriberOutcome{SubscriptionID: sub.ID, Wallet: sub.Wallet}

	// THE LEASE ON THIS WALLET, taken before anything is read and long before
	// anything is signed.
	//
	// The buyer's own stop loss takes the same lease when it fires, so one
	// intent cannot become two transactions in one account. It is keyed on the
	// SUBSCRIPTION, not the agent: a lease per agent would make one buyer's
	// trade block every other buyer's, and would make a buyer's stop unable to
	// fire for as long as the agent was trading for anybody at all.
	if lerr := e.store.AcquireLease(ctx, sub.ID, leaseHolderCycle, LeaseTTL,
		fmt.Sprintf("%s %s for a subscriber", intent.Action, intent.Symbol)); lerr != nil {
		if errors.Is(lerr, store.ErrLeaseHeld) {
			who, until, _, _ := e.store.LeaseHolder(ctx, sub.ID)
			res.Status = "stood_down"
			res.Note = fmt.Sprintf("%s holds this wallet's execution lease until %s; nothing was "+
				"signed for this subscriber on this tick", who, until.UTC().Format(time.RFC3339))
			return res
		}
		res.Status, res.Note = "unreadable", "lease: "+lerr.Error()
		return res
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), sub.ID, leaseHolderCycle); rerr != nil {
			log.Printf("subscription %s: lease not released early, it will expire: %v", sub.ID, rerr)
		}
	}()

	before, err := e.broker.Read(ctx, sub.Wallet)
	if err != nil {
		res.Status, res.Note = "unreadable", "could not read the wallet: "+err.Error()
		return res
	}

	// THE CUSTODY CHECK, on the subscriber's own record. The wallet is theirs —
	// they can export the key and move funds themselves — so a difference is
	// recorded rather than treated as a fault, exactly as it is for a creator
	// whose key they also hold.
	e.noteSubscriptionDrift(ctx, sub, before)

	holdings := toAnyMap(before.Holdings)
	nav := before.Cash
	for sym, q := range holdings {
		if p, ok := prices[sym]; ok {
			nav += toFloat(q) * p
		}
	}

	// THE BUYER'S LIMITS SIZE THE BUYER'S POSITION.
	limits := riskLimitsFrom(sub.RiskProfile)
	limits.QtyStep = OnChainQtyStep

	qty := 0.0
	switch intent.Action {
	case "buy":
		view := marketView{prices: prices}
		qty = buyableQty(intent.Symbol, view, holdings, before.Cash, nav, limits)
		if qty <= 0 {
			res.Status = "declined"
			res.Note = fmt.Sprintf(
				"nothing to buy under this subscription's own limits: cash %.2f, book %.2f, "+
					"trade size %.0f%%, cash floor %.0f%%",
				before.Cash, nav, limits.TradeSizePct*100, limits.CashFloorPct*100)
			e.recordSubscriberDecline(ctx, req, decisionID, intent, sub, ReasonInsufficientCapital, res.Note)
			e.recordSubscriberOutcome(ctx, sub, decisionID, intent, res)
			return res
		}
	case "sell":
		qty = HeldQty(holdings, intent.Symbol)
		if qty <= 0 {
			res.Status = "declined"
			res.Note = "this subscription holds no " + intent.Symbol + " to sell"
			e.recordSubscriberDecline(ctx, req, decisionID, intent, sub, ReasonNothingToSell, res.Note)
			e.recordSubscriberOutcome(ctx, sub, decisionID, intent, res)
			return res
		}
	}

	// THE SIGNER IS ASKED FOR THE SUBSCRIPTION'S WALLET, not the agent's.
	//
	// It derives the address from the id it is given and forces proceeds there,
	// so passing the subscription id is what makes it structurally impossible
	// for one subscriber's trade to land in another's wallet — or in the
	// creator's. The daily signature cap keys on the same id, so it is already
	// per wallet rather than per agent.
	er, xerr := e.broker.Execute(ctx, execution.Request{
		AgentID: sub.ID, Wallet: sub.Wallet,
		Action: intent.Action, Symbol: intent.Symbol, Qty: qty, Price: prices[intent.Symbol],
		ExactUnitsIn: e.exitUnits(tradeIntent{Action: intent.Action, Symbol: intent.Symbol, Quantity: qty}, before),
	})
	if xerr != nil {
		res.Status, res.Note = "failed", "execute: "+xerr.Error()
		return res
	}

	wctx, release := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer release()
	execID, aerr := e.store.AppendExecution(wctx, store.ExecutionInsert{
		AgentID: req.AgentID, DecisionID: &decisionID, TS: req.Timestamp,
		SubscriptionID: &sub.ID, Wallet: sub.Wallet, OnBehalfOf: "subscriber",
		IntentAction: er.IntentAction, Symbol: er.Symbol,
		TokenIn: er.TokenIn, TokenOut: er.TokenOut,
		AmountIn: er.AmountIn, QuotedOut: er.QuotedOut, MinOut: er.MinOut,
		Filled: er.Filled, SlippageBps: er.SlippageBps,
		TxHash: er.TxHash, BlockNumber: er.BlockNumber,
		GasUsed: er.GasUsed, GasPriceWei: er.GasPriceWei, GasCostWei: er.GasCostWei,
		Status: er.Status, RefusalCode: er.RefusalCode, Note: er.Note,
		FeeTier: er.FeeTier, PoolFeeUnits: er.PoolFeeUnits,
		PoolFeeUSD: er.PoolFeeUSD, GasCostUSD: er.GasCostUSD, EthUSD: er.EthUSD,
	})
	if aerr != nil {
		log.Printf("ERROR subscription %s: execution %s could not be recorded: %v", sub.ID, er.Status, aerr)
	}
	var execPtr *int64
	if execID != 0 {
		execPtr = &execID
	}
	// THE SUBSCRIBER'S OWN BOOK (0051). Their fill, their price, their cost
	// basis — never the agent's, and never added into the agent's totals.
	e.writeFill(wctx, req.AgentID, store.FillBook{SubscriptionID: sub.ID}, &decisionID, execPtr,
		req.Timestamp, "on_chain", e.chainFillFrom(er, before))

	// The approval is its own transaction with its own gas, paid by this wallet.
	if ap := er.Approve; ap != nil {
		if _, err := e.store.AppendExecution(wctx, store.ExecutionInsert{
			AgentID: req.AgentID, DecisionID: &decisionID, TS: req.Timestamp,
			SubscriptionID: &sub.ID, Wallet: sub.Wallet, OnBehalfOf: "subscriber",
			IntentAction: "approve", Symbol: er.Symbol,
			TokenIn: ap.Token, TokenOut: ap.Token, AmountIn: ap.Amount,
			TxHash: ap.TxHash, GasUsed: ap.GasUsed,
			GasPriceWei: ap.GasPriceWei, GasCostWei: ap.GasCostWei,
			GasCostUSD: ap.GasCostUSD, EthUSD: ap.EthUSD,
			Status: ap.Status, Note: ap.Note,
		}); err != nil {
			log.Printf("ERROR subscription %s: the approval %s was broadcast and its cost was not "+
				"recorded: %v", sub.ID, ap.TxHash, err)
		}
	}

	// THE BUYER'S OWN LEVELS, FROM THE BUYER'S OWN FILL.
	//
	// The agent named percentages; each wallet turns them into absolute prices
	// against the price IT paid, in the pool it traded. Copying the creator's
	// levels across would anchor a buyer's stop to a price that wallet never
	// paid — and the fills genuinely differ: different sizes, different blocks,
	// different slippage.
	//
	// A level this pool refuses is refused for the buyer too, and recorded as a
	// row they can read. The user's instruction was that the choice must be
	// taken rather than discovered: a buyer whose stop was never armed finds
	// that out in their book, not at the moment they needed it.
	e.applySubscriberGuard(wctx, req.AgentID, sub, decisionID, intent, er, before)

	// What the wallet holds NOW, read from the chain rather than derived.
	after, rerr := e.broker.Read(ctx, sub.Wallet)
	if rerr != nil {
		res.Status, res.Note = er.Status, "executed, and the wallet could not be read back: "+rerr.Error()
		return res
	}
	afterHoldings := toAnyMap(after.Holdings)
	afterNAV := after.Cash
	for sym, q := range afterHoldings {
		if p, ok := prices[sym]; ok {
			afterNAV += toFloat(q) * p
		}
	}
	if err := e.store.WriteSubscriptionSnapshot(wctx, sub.ID, req.Timestamp, afterHoldings,
		fmt.Sprintf("%.2f", afterNAV), fmt.Sprintf("%.2f", after.Cash), &decisionID); err != nil {
		log.Printf("ERROR subscription %s: book not marked to market: %v", sub.ID, err)
	}

	res.Status = er.Status
	res.Note = executionSummary(er)
	return res
}

// recordSubscriberOutcome writes a book snapshot for a wallet that did NOT
// trade, so a subscriber can tell "the agent decided nothing applied to me"
// from "nothing happened and nobody knows why".
func (e *Engine) recordSubscriberOutcome(ctx context.Context, sub store.TradingSubscription,
	decisionID int64, intent tradeIntent, res SubscriberOutcome) {

	pos, err := e.broker.Read(ctx, sub.Wallet)
	if err != nil {
		return
	}
	holdings := toAnyMap(pos.Holdings)
	if serr := e.store.WriteSubscriptionSnapshot(ctx, sub.ID, time.Now().UTC(), holdings,
		fmt.Sprintf("%.2f", pos.Cash), fmt.Sprintf("%.2f", pos.Cash), &decisionID); serr != nil {
		log.Printf("ERROR subscription %s: book not marked after a declined intent: %v", sub.ID, serr)
	}
}

// noteSubscriptionDrift compares what ARCANA last recorded for this buyer
// against what their wallet holds.
//
// NOT AN ERROR, for the same reason it is not one for a creator whose key they
// also hold: the subscriber can export this wallet and move funds themselves,
// and halting because somebody used their own money would be the platform
// overruling them. It is recorded because an unexplained balance change is the
// hardest thing to reconstruct afterwards.
func (e *Engine) noteSubscriptionDrift(ctx context.Context, sub store.TradingSubscription, pos *execution.Position) {
	recorded, recordedCash, ok, _ := e.store.LastSubscriptionHoldings(ctx, sub.ID)
	if !ok {
		return
	}
	note := "funds moved outside ARCANA; the subscriber holds this wallet's key too"

	qd := e.broker.QuoteDecimals()
	expectedCash := toUnits(recordedCash, qd)
	cashFloor := new(big.Int).Div(pow10(qd), big.NewInt(200))
	// LOGGED, NOT WRITTEN TO custody_drift. That table's agent_id is a foreign
	// key into agents, and a subscription is not an agent — forcing one in would
	// either break the constraint or, worse, file a subscriber's difference
	// under somebody else's name. A subscriber's reconciliation belongs in their
	// own record, and until that table exists this says so in the journal rather
	// than pretending otherwise.
	if differs(expectedCash, pos.CashUnits, cashFloor) {
		log.Printf("custody drift subscription=%s CASH expected=%s observed=%s (%s)",
			sub.ID, expectedCash, pos.CashUnits, note)
	}
	for sym, v := range recorded {
		dec := e.broker.DecimalsOf(sym)
		expected := toUnits(toFloat(v), dec)
		observed := pos.Units[sym]
		if observed == nil {
			observed = big.NewInt(0)
		}
		if differs(expected, observed, floorFor(dec)) {
			log.Printf("custody drift subscription=%s %s expected=%s observed=%s (%s)",
				sub.ID, sym, expected, observed, note)
		}
	}
}

// applySubscriberGuard arms, refuses or clears this buyer's protective levels.
//
// It goes through the SAME applyGuardChanges the creator's path uses, with the
// subscription id attached. One place decides what arming means, so a
// subscriber's guard cannot drift into a different shape from a creator's —
// which matters most for the refusal, because a refusal is a promise that was
// not kept and both owners deserve to hear it the same way.
func (e *Engine) applySubscriberGuard(ctx context.Context, agentID string, sub store.TradingSubscription,
	decisionID int64, intent tradeIntent, er *execution.Result, before *execution.Position) {

	if er.Status != execution.StatusMined {
		// Nothing moved, so there is no new position to protect and no old one
		// to stop protecting. A level armed against a trade that did not happen
		// would be a stop over a position this wallet does not hold.
		return
	}

	switch er.IntentAction {
	case "buy":
		bought := unitsToShares(er.Filled, e.broker.DecimalsOf(er.Symbol))
		fill := e.filledPrice(er)
		entry, qty, basis := e.blendEntry(ctx, agentID, &sub.ID, er.Symbol, fill, bought, before)
		lv := resolveGuardLevels(intent.Guards, entry, e.broker.PoolFeeOf(er.Symbol))
		if !lv.Asked() {
			return
		}
		set := settlement{}
		pg := &pendingGuard{Symbol: er.Symbol, EntryPrice: entry, EntryQty: qty, Levels: lv, Basis: basis}
		if lv.any() {
			set.Guard = pg
		} else {
			set.RefusedGuard = pg
		}
		e.applyGuardChanges(ctx, agentID, &sub.ID, &decisionID, set)

	case "sell":
		// The buyer's position left by the agent's own decision, so anything
		// armed on it is no longer guarding anything.
		e.applyGuardChanges(ctx, agentID, &sub.ID, &decisionID,
			settlement{ClearGuard: er.Symbol})
	}
}

// Refusal codes for a wallet that was left out of a fan-out by its own limits.
//
// These are not chain refusals: nothing was signed and nothing was sent. They
// exist so that "this buyer was not traded for" is a ROW rather than a log
// line.
const (
	ReasonInsufficientCapital = "insufficient_capital"
	ReasonNothingToSell       = "nothing_to_sell"
)

// recordSubscriberDecline writes the fact that one wallet was left out.
//
// WHY A ROW AND NOT JUST A LOG LINE. The rule is that one wallet failing must
// not fail the others AND that each failure is recorded on its own. The first
// half was true from the start; the second was not. A buyer whose wallet was
// empty got a book snapshot showing nothing and a line in the journal — so
// "the agent decided nothing applied to me", "my wallet was empty" and "the
// fan-out never reached me" were indistinguishable to the only person who
// needed to tell them apart.
//
// It is deliberately the SAME table as a real execution, with status 'blocked'
// and an amount of zero. A separate table would be a second place to look, and
// the question a buyer asks is "what happened to me on this decision" — one
// query, one answer, whether or not anything moved.
func (e *Engine) recordSubscriberDecline(ctx context.Context, req ExecuteRequest, decisionID int64,
	intent tradeIntent, sub store.TradingSubscription, reason, note string) {

	// ONCE, NOT ONCE PER TICK. See RecentRefusalFor: the cadence fires every
	// minute and this condition can persist for days.
	had, err := e.store.RecentRefusalFor(ctx, sub.ID, intent.Symbol, reason, 24*time.Hour)
	if err != nil {
		log.Printf("subscription %s: could not tell whether this refusal is new, recording it: %v",
			sub.ID, err)
	}
	if had {
		return
	}

	if _, err := e.store.AppendExecution(ctx, store.ExecutionInsert{
		AgentID: req.AgentID, DecisionID: &decisionID, TS: req.Timestamp,
		SubscriptionID: &sub.ID, Wallet: sub.Wallet, OnBehalfOf: "subscriber",
		IntentAction: intent.Action, Symbol: intent.Symbol,
		TokenIn: e.broker.QuoteAddress(), TokenOut: e.broker.AddressOf(intent.Symbol),
		AmountIn: big.NewInt(0),
		Status:   execution.StatusBlocked, RefusalCode: reason, Note: note,
	}); err != nil {
		log.Printf("ERROR subscription %s: the decision did not reach this wallet and the reason "+
			"was not recorded: %v", sub.ID, err)
	}
}
