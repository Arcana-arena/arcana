package engine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// A protective exit in a BUYER's wallet.
//
// THE LEVEL IS THE SAME INSTRUCTION; THE MONEY IS SOMEBODY ELSE'S. When the
// agent opens a position it names a stop and a target, and the fan-out opens
// that position in every subscriber's wallet at a price each wallet got for
// itself. So each wallet gets its own levels, measured from its own fill, in
// its own pool — never the creator's levels copied across, which would be
// percentages anchored to a price that wallet never paid.
//
// WHAT IS DELIBERATELY NOT WRITTEN: a row in `decisions`.
//
// `decisions` is the agent's competition record, and it answers "what did this
// agent decide". A stop firing in one buyer's wallet, at a price only that
// wallet crossed, seconds after the same level did not fire in the creator's,
// is not something the agent decided — it is one instruction meeting one
// account. Writing it there would inflate an agent's decision count by the size
// of its customer list, which is the exact failure the whole subscription
// design exists to avoid: an agent measuring its sales rather than its trading.
//
// WHAT DECIDED IS STILL RECORDED, in three places that together say everything
// a decision row would have:
//
//	position_guards   the level, when it was set, from what entry, and — once
//	                  it fires — triggered_at, triggered_side, triggered_price.
//	executions        subscription_id, wallet, on_behalf_of, and guard_id: the
//	                  fill, the slippage, the gas, and the instruction that
//	                  caused it.
//	subscription_snapshots  the buyer's book, before and after.
//
// EVERY BRAKE STILL APPLIES, and they apply to the BUYER's wallet rather than
// the agent's: the signer derives from the subscription id, so the daily
// signature cap is that subscriber's; the cost meter reads that subscriber's
// spend against that subscriber's book; gas comes out of that subscriber's ETH.

// guardSubject is whose position a guard is watching, and under whose limits.
//
// Resolved once, at the top of the exit, so that no later step has to ask again
// whether this is a creator's position or a buyer's — a question answered twice
// is a question that can be answered differently.
type guardSubject struct {
	AgentID string
	SubID   *string
	// Chain is the creator's wallet record, nil for a subscriber (there is no
	// `agents` row behind a subscription wallet, and the settlement path that
	// needs one is not used for subscribers).
	Chain  *store.ChainWallet
	Wallet string
	// SignerID is the opaque id the signer derives the wallet from: the agent
	// id for a creator, the subscription id for a buyer. It is also the lease
	// key and the key the daily signature cap counts against.
	SignerID string
	// Budget is the OWNER's cost brake, from the owner's own risk_profile.
	// Zero means unmetered, which is the default and not a degraded mode.
	Budget float64
	Meter  costSubject
	Who    string
}

// guardStandDown is a reason not to act on a crossing right now.
//
// Permanent distinguishes "this buyer paused trading" from "this subscription
// has ended". The first leaves the level armed and waiting; the second takes it
// down and records that the position is now unprotected, because an agent
// nobody is paying must not keep signing.
type guardStandDown struct {
	Reason    string
	Permanent bool
}

// guardSubjectFor resolves whose money a guard watches.
func (e *Engine) guardSubjectFor(ctx context.Context, g store.Guard) (*guardSubject, *guardStandDown, error) {
	who := guardWho(g.AgentID, g.SubscriptionID)

	if g.SubscriptionID == nil {
		w, err := e.store.ChainWalletFor(ctx, g.AgentID)
		if err != nil {
			return nil, nil, fmt.Errorf("wallet for %s: %w", g.AgentID, err)
		}
		if w == nil {
			return nil, &guardStandDown{
				Reason:    "the agent has no chain wallet, so this guard could never be acted on",
				Permanent: true,
			}, nil
		}
		// THE AGENT'S OWN STATUS DECIDES WHAT THIS LEVEL MEANS.
		//
		// Read through GetAgent rather than GetActiveAgent on purpose: the
		// second refuses anything but 'active', and using it here had two
		// consequences that were never intended. It meant a paused agent's
		// owner silently lost their cost brake (the error was tolerated and
		// the budget fell back to "unmetered"), and it encoded the idea that
		// a level belongs to a running agent rather than to the person whose
		// money is in the position.
		ag, aerr := e.store.GetAgent(ctx, g.AgentID)
		if aerr != nil {
			// UNREADABLE IS NOT ABSENT — the same rule the subscription branch
			// below keeps. A row that cannot be read must not become a
			// stand-down that quietly disarms a stop loss, and it must not
			// become an unmetered exit either. The level stays armed and the
			// watcher reports it.
			return nil, nil, fmt.Errorf("agent %s for guard %d: %w", g.AgentID, g.ID, aerr)
		}
		switch ag.Status {
		case "active", "paused":
			// A PAUSE STOPS DECIDING, NOT PROTECTING. The owner's standing
			// instruction about their own position outlives the agent's turn
			// to speak; retiring is the way to stand everything down.
		default:
			// RETIRED OR NEVER STARTED: permanent. The level comes down and
			// the reason is written on the row, which is the part the old
			// `a.status = 'active'` filter could not do — a guard the query
			// cannot see is a guard nothing can ever close, so a retired
			// agent's levels stayed "armed" forever with nothing watching
			// them.
			return nil, &guardStandDown{
				Reason: fmt.Sprintf(
					"the agent is %s, so it will not act again. The position was NOT closed — it is "+
						"yours and it stays where it is — but this level is taken down rather than "+
						"left saying \"armed\" with nothing watching it", ag.Status),
				Permanent: true,
			}, nil
		}
		budget := riskLimitsFrom(ag.RiskProfile).CostBudgetMonthlyPct
		return &guardSubject{
			AgentID: g.AgentID, Chain: w, Wallet: w.Address, SignerID: g.AgentID,
			Budget: budget, Meter: e.agentSubject(g.AgentID), Who: who,
		}, nil, nil
	}

	sub, status, err := e.store.SubscriptionByID(ctx, *g.SubscriptionID)
	if err != nil {
		// UNREADABLE IS NOT ABSENT. A subscription that cannot be read must not
		// become a stand-down that quietly disarms a stop loss, so this is an
		// error the watcher reports rather than a decision it makes.
		return nil, nil, err
	}
	allowed, reason, err := e.store.TradingAllowed(ctx, *g.SubscriptionID)
	if err != nil {
		return nil, nil, err
	}
	if !allowed {
		// ENDED IS PERMANENT, PAUSED IS NOT.
		//
		// A subscription that has run out is a mandate that has ended: the
		// agent stops signing for that wallet, and the position it leaves stays
		// exactly where it is — which was decided deliberately, because picking
		// the moment to sell somebody's position is a trading decision nobody
		// asked this platform to make. The level comes down and the absence of
		// protection becomes a row the buyer can read, rather than an armed
		// guard that will never fire and looks like protection until the day it
		// is needed.
		ended := status != "active" || !sub.ExpiresAt.After(time.Now())
		return nil, &guardStandDown{Reason: reason, Permanent: ended}, nil
	}
	if sub.Wallet == "" {
		return nil, &guardStandDown{
			Reason:    "this subscription has no trading wallet, so the level has nowhere to act",
			Permanent: true,
		}, nil
	}
	return &guardSubject{
		AgentID: g.AgentID, SubID: g.SubscriptionID, Wallet: sub.Wallet, SignerID: sub.ID,
		Budget: riskLimitsFrom(sub.RiskProfile).CostBudgetMonthlyPct,
		Meter:  e.subscriptionSubject(sub.ID), Who: who,
	}, nil, nil
}

// standDown is what happens to a guard that must not act.
func (e *Engine) standDown(ctx context.Context, g store.Guard, s guardStandDown) (ProtectiveOutcome, error) {
	if !s.Permanent {
		// The level stays armed. A buyer who unpauses expects to find their
		// stop still watching, and the refusal is remembered on the guard so it
		// is visible in their book rather than only in a log nobody reads.
		if err := e.store.NoteRefusal(ctx, g.ID, s.Reason, nil); err != nil {
			log.Printf("ERROR guard %d: stand-down not remembered: %v", g.ID, err)
		}
		return ProtectiveOutcome{Status: "stood_down", Note: s.Reason}, nil
	}

	if _, err := e.store.CloseGuard(ctx, g.ID, "expired", "", nil, nil, s.Reason); err != nil {
		log.Printf("ERROR guard %d: not closed after a permanent stand-down: %v", g.ID, err)
	}
	if g.SubscriptionID != nil {
		// THE POSITION IS STILL THERE AND IS NOW UNPROTECTED, and that has to be
		// a fact the buyer can query rather than something they discover. Same
		// row, same shape and same alarm as a level the pool refused at entry.
		if err := e.store.RecordRefusedGuard(ctx, store.RefusedGuardInsert{
			AgentID: g.AgentID, SubscriptionID: g.SubscriptionID, Symbol: g.Symbol,
			EntryPrice: g.EntryPrice, EntryQty: g.EntryQty,
			Reason: fmt.Sprintf("the protective level set at entry was stood down because %s. "+
				"The position was NOT closed — it is yours and it stays where it is — but nothing "+
				"is watching it any more. Export the wallet key to manage it yourself, or renew "+
				"the subscription to have the agent trade for you again", s.Reason),
		}); err != nil {
			log.Printf("ERROR subscription %s: %s is now UNPROTECTED and the refusal was not "+
				"recorded: %v", *g.SubscriptionID, g.Symbol, err)
		}
	}
	return ProtectiveOutcome{Status: "expired", Note: s.Reason}, nil
}

// exitForSubscriber sells one buyer's position because their own level was
// crossed. Same order of checks as the creator's exit, and the only one that
// spends gas is last.
func (e *Engine) exitForSubscriber(ctx context.Context, t Trigger, subj guardSubject) (ProtectiveOutcome, error) {
	g := t.Guard

	// 1. THE LEASE, keyed on this WALLET.
	//
	// The fan-out takes the same lease before it trades for this subscriber, so
	// a stop firing while the agent is buying into the same wallet stands down
	// rather than becoming a second transaction. It does NOT contend with the
	// creator's lease or with any other subscriber's: those are different
	// accounts, and making them wait on each other would mean a stop loss that
	// cannot fire because somebody else's wallet is busy.
	if lerr := e.store.AcquireLease(ctx, subj.SignerID, leaseHolderGuard, LeaseTTL,
		fmt.Sprintf("%s on %s", t.Side, g.Symbol)); lerr != nil {
		if errors.Is(lerr, store.ErrLeaseHeld) {
			who, until, _, _ := e.store.LeaseHolder(ctx, subj.SignerID)
			return ProtectiveOutcome{Status: "stood_down", Note: fmt.Sprintf(
				"%s holds this wallet's execution lease until %s; the guard stays armed",
				who, until.UTC().Format(time.RFC3339))}, nil
		}
		return ProtectiveOutcome{}, fmt.Errorf("lease: %w", lerr)
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), subj.SignerID, leaseHolderGuard); rerr != nil {
			log.Printf("%s: guard lease not released early, it will expire: %v", subj.Who, rerr)
		}
	}()

	// 2. IS THE POSITION STILL THERE, by the shared definition, read again
	// under the lease.
	units, uerr := e.broker.UnitsOf(ctx, subj.Wallet, g.Symbol)
	if uerr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("read position: %w", uerr)
	}
	shares := unitsToShares(units, e.broker.DecimalsOf(g.Symbol))
	if !HasPosition(map[string]any{g.Symbol: shares}, g.Symbol) {
		_, _ = e.store.CloseGuard(ctx, g.ID, "expired", "", nil, nil, fmt.Sprintf(
			"nothing left to guard: the wallet holds %s base units of %s, which is below the "+
				"smallest quantity that can be recorded", units.String(), g.Symbol))
		return ProtectiveOutcome{Status: "expired", Note: "position gone or dust"}, nil
	}

	// 3. THE PRICE AGAIN, freshly, under the lease.
	price, perr := e.broker.RealizablePrice(ctx, subj.Wallet, g.Symbol, units)
	if perr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("re-price: %w", perr)
	}
	side := crossed(struct{ TakeProfit, StopLoss *float64 }{g.TakeProfit, g.StopLoss}, price)
	if side == "" {
		return ProtectiveOutcome{Status: "receded", Note: fmt.Sprintf(
			"%s was at %.6f when the scan looked and is at %.6f now, which is back inside the "+
				"levels; the guard stays armed", g.Symbol, t.Price, price)}, nil
	}
	t.Side, t.Price = side, price

	// 4. THE COST METER — THE BUYER'S OWN, and it can refuse this.
	//
	// The same brake for the same reason it applies to a creator: an account
	// already spending more than its owner agreed to does not get an exception
	// for the transaction nobody wants to be the one to refuse. It is measured
	// against the BUYER's book and the BUYER's spending, so a creator's budget
	// can neither hold back a buyer's stop nor excuse it.
	//
	// The refusal is remembered on the guard row and nowhere else. There is no
	// decision row for a subscriber's protective exit — see the file comment —
	// so the guard row IS the record, and the buyer's book reads it back.
	if cv := e.checkCostFor(ctx, subj.Meter, subj.Budget); cv.pause {
		if nerr := e.store.NoteRefusal(ctx, g.ID, cv.reason, nil); nerr != nil {
			log.Printf("ERROR %s: guard %d refusal not remembered: %v", subj.Who, g.ID, nerr)
		}
		log.Printf("%s: guard %d held back by this subscription's own cost budget: %s",
			subj.Who, g.ID, cv.detail)
		return ProtectiveOutcome{Status: "cost_blocked",
			Note: "the subscription's cost meter refused the exit; the guard stays armed: " + cv.detail}, nil
	}
	if rerr := e.store.ClearRefusal(ctx, g.ID); rerr != nil {
		log.Printf("%s: guard %d refusal state not cleared: %v", subj.Who, g.ID, rerr)
	}

	// 5. THE EXIT, through the same broker, the same signer, the same allowlist.
	//
	// ExactUnitsIn is the integer balance, so the position closes with nothing
	// left behind — the same rule as every other exit, and the reason a wei of
	// residue cannot be read back as a position.
	before, berr := e.broker.Read(ctx, subj.Wallet)
	if berr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("read wallet: %w", berr)
	}
	er, xerr := e.broker.Execute(ctx, execution.Request{
		AgentID: subj.SignerID, Wallet: subj.Wallet,
		Action: "sell", Symbol: g.Symbol, Qty: shares, Price: price,
		ExactUnitsIn: units,
	})
	if xerr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("execute: %w", xerr)
	}

	// The row is written even if the caller's context has given up: once a
	// transaction is broadcast, the record of it is not optional.
	wctx, release := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer release()

	execID, aerr := e.store.AppendExecution(wctx, store.ExecutionInsert{
		AgentID: g.AgentID, DecisionID: nil, TS: time.Now().UTC(),
		SubscriptionID: subj.SID(), Wallet: subj.Wallet, OnBehalfOf: "subscriber",
		GuardID:      &g.ID,
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
		log.Printf("ERROR %s: protective exit %s could not be recorded: %v", subj.Who, er.Status, aerr)
	}
	_ = execID

	if ap := er.Approve; ap != nil {
		if _, err := e.store.AppendExecution(wctx, store.ExecutionInsert{
			AgentID: g.AgentID, TS: time.Now().UTC(),
			SubscriptionID: subj.SID(), Wallet: subj.Wallet, OnBehalfOf: "subscriber",
			GuardID:      &g.ID,
			IntentAction: "approve", Symbol: er.Symbol,
			TokenIn: ap.Token, TokenOut: ap.Token, AmountIn: ap.Amount,
			TxHash: ap.TxHash, GasUsed: ap.GasUsed,
			GasPriceWei: ap.GasPriceWei, GasCostWei: ap.GasCostWei,
			GasCostUSD: ap.GasCostUSD, EthUSD: ap.EthUSD,
			Status: ap.Status, Note: ap.Note,
		}); err != nil {
			log.Printf("ERROR %s: the approval %s was broadcast and its cost was not recorded: %v",
				subj.Who, ap.TxHash, err)
		}
	}

	// 6. THE BOOK, marked from the chain rather than derived from the intent.
	after, rerr := e.broker.Read(ctx, subj.Wallet)
	if rerr != nil {
		log.Printf("ERROR %s: exit executed and the wallet could not be read back: %v", subj.Who, rerr)
		after = before
	}
	holdings := toAnyMap(after.Holdings)
	nav := after.Cash
	for sym, q := range holdings {
		if p, perr := e.broker.RealizablePrice(ctx, subj.Wallet, sym, after.Units[sym]); perr == nil {
			nav += toFloat(q) * p
		}
	}
	if err := e.store.WriteSubscriptionSnapshot(wctx, *subj.SubID, time.Now().UTC(), holdings,
		fmt.Sprintf("%.2f", nav), fmt.Sprintf("%.2f", after.Cash), nil); err != nil {
		log.Printf("ERROR %s: book not marked to market after a protective exit: %v", subj.Who, err)
	}

	// 7. CLOSE THE GUARD, and only on a real exit. A reverted or unresolved
	// attempt leaves the level ARMED: the position is still there and still
	// past the level, so the protection is still wanted.
	if er.Status == execution.StatusMined {
		ok, cerr := e.store.CloseGuard(ctx, g.ID, "triggered", t.Side, &t.Price, nil, fmt.Sprintf(
			"%s exit executed at %.6f against a level of %.6f, in subscription %s's wallet %s "+
				"(tx %s). No decision row: the agent did not decide this, the level did",
			t.Side, t.Price, levelOf(g, t.Side), *subj.SubID, subj.Wallet, er.TxHash))
		if cerr != nil {
			log.Printf("ERROR %s: guard %d fired and was not closed: %v", subj.Who, g.ID, cerr)
		} else if !ok {
			log.Printf("%s: guard %d was already closed by somebody else", subj.Who, g.ID)
		}
		return ProtectiveOutcome{Executed: true, Status: er.Status, Note: executionSummary(er)}, nil
	}

	log.Printf("%s: protective exit on %s did not complete (%s); the guard stays armed",
		subj.Who, g.Symbol, er.Status)
	return ProtectiveOutcome{Status: er.Status, Note: executionSummary(er)}, nil
}

// SID is the subscription id as the execution row wants it. A method rather
// than a field read at each call site, so a creator's exit cannot accidentally
// write a non-nil one.
func (s guardSubject) SID() *string { return s.SubID }

// --- read-only inspection, for the verification suite ----------------------

// NewForInspection builds an engine that can ANSWER questions and cannot act.
//
// No market data, no LLM, no broker. The subject resolution needs none of them,
// and a nil broker is a second guarantee: if somebody later teaches the
// resolution to want a price, this will panic in a verification rather than
// quietly reach the chain from a tool that promised not to.
func NewForInspection(st *store.Store) *Engine { return New(st, nil) }

// InspectGuardSubject is guardSubjectFor, exported for the subcheck binary.
//
// SAME FUNCTION, NOT A COPY OF IT. A verification that re-implemented the rule
// would be checking its own idea of the rule; this is the one the watcher runs.
func (e *Engine) InspectGuardSubject(ctx context.Context, g store.Guard) (*guardSubject, *guardStandDown, error) {
	return e.guardSubjectFor(ctx, g)
}

// Exported accessors, so the inspection binary can print what it resolved
// without the subject's fields becoming part of the package's public surface.
func (s guardSubject) WalletAddress() string { return s.Wallet }
func (s guardSubject) Signer() string        { return s.SignerID }
func (s guardSubject) BudgetPct() float64    { return s.Budget }
func (s guardSubject) Describe() string      { return s.Who }
func (s guardStandDown) Why() string         { return s.Reason }
func (s guardStandDown) IsPermanent() bool   { return s.Permanent }
