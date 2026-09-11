package engine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

// The protective exit: what happens when a take-profit or stop-loss level is
// crossed.
//
// IT IS A DECISION WITH A DIFFERENT AUTHOR, not an execution without a
// decision. The agent acted; something decided; the record has to name it.
// `decisions.decider` already carried exactly this axis — deterministic, llm,
// human — and this adds `protective` to it. The alternative, an execution row
// with a NULL decision_id, would say that nothing decided, which is the one
// thing that is definitely false.
//
// What a protective decision does NOT carry is load-bearing too. No provider,
// no model, no params, no prompt, no response, and no thesis: there was no
// model and no forward-looking claim. Those columns stay NULL because the
// record is refusing to invent an author, not because nobody filled them in.
//
// That distinction is the whole reason this is worth building carefully. An
// agent that made money because its stop loss worked is not the same agent as
// one whose calls were good, and the Passport has to be able to tell them
// apart. It can only do that if the rows say which.
//
// EVERY BRAKE STILL APPLIES. This path goes through the same broker, the same
// signer, the same allowlist and the same cost meter as an ordinary trade. It
// is not a route around the limits — the signature cap counts this signature
// like any other, and the cost meter can and does refuse it. See the comment on
// the cost check below for why refusing a stop loss is the right answer rather
// than the frightening one.

// Reason codes recorded on a protective decision.
const (
	ReasonStopLoss   = "stop_loss"
	ReasonTakeProfit = "take_profit"
)

// DeciderProtective is written to decisions.decider.
const DeciderProtective = "protective"

// Trigger is one guard whose level a fresh price has crossed.
type Trigger struct {
	Guard store.Guard
	Side  string  // stop_loss | take_profit
	Price float64 // the realizable price that crossed it
}

// ProtectiveOutcome says what happened, for the watcher's log and its counters.
type ProtectiveOutcome struct {
	Executed   bool
	DecisionID int64
	Status     string
	Note       string
}

// ExecuteProtective sells a position because a level was crossed.
//
// The order of the checks is the design. Each one can stop the exit, each one
// costs less than the one after it, and the only one that spends gas is last.
func (e *Engine) ExecuteProtective(ctx context.Context, t Trigger) (ProtectiveOutcome, error) {
	g := t.Guard
	if e.broker == nil {
		return ProtectiveOutcome{}, errors.New("chain execution is not configured; a protective exit has nowhere to go")
	}

	// WHOSE POSITION IS THIS, asked once and never asked again.
	//
	// A guard now watches either the creator's wallet or one buyer's, and every
	// step after this — the lease key, the balance, the price, the cost budget,
	// the signer identity — belongs to that one account. A question answered
	// twice is a question that can be answered differently, and the difference
	// here would be a stop loss selling the wrong person's position.
	subj, stand, serr := e.guardSubjectFor(ctx, g)
	if serr != nil {
		return ProtectiveOutcome{}, serr
	}
	if stand != nil {
		return e.standDown(ctx, g, *stand)
	}
	if g.SubscriptionID != nil {
		// A BUYER'S EXIT TAKES ITS OWN PATH, because the creator's one settles
		// into the agent's competition record: a portfolio, a decision, a
		// snapshot the Scoring Engine reads. None of those are the buyer's, and
		// writing a buyer's exit into them would move the agent's number for a
		// reason that has nothing to do with its judgement.
		return e.exitForSubscriber(ctx, t, *subj)
	}
	wallet := subj.Chain

	// 1. THE LEASE, before anything is read and long before anything is signed.
	//
	// If the decision cycle holds it, this agent's funds are already being
	// moved and the position this guard is watching may be part of that. The
	// guard stands down and leaves the level armed: a stop loss that fires on
	// the next scan is a stop loss; a position sold twice is not recoverable.
	if lerr := e.store.AcquireLease(ctx, subj.SignerID, leaseHolderGuard, LeaseTTL,
		fmt.Sprintf("%s on %s", t.Side, g.Symbol)); lerr != nil {
		if errors.Is(lerr, store.ErrLeaseHeld) {
			who, until, _, _ := e.store.LeaseHolder(ctx, subj.SignerID)
			return ProtectiveOutcome{Status: "stood_down", Note: fmt.Sprintf(
				"%s holds the execution lease until %s; the guard stays armed",
				who, until.UTC().Format(time.RFC3339))}, nil
		}
		return ProtectiveOutcome{}, fmt.Errorf("lease: %w", lerr)
	}
	defer func() {
		if rerr := e.store.ReleaseLease(context.WithoutCancel(ctx), subj.SignerID, leaseHolderGuard); rerr != nil {
			log.Printf("agent %s: guard lease not released early, it will expire: %v", g.AgentID, rerr)
		}
	}()

	// 2. IS THE POSITION STILL THERE, by the shared definition.
	//
	// Read again under the lease, because the scan that found this trigger ran
	// before the lease was held and the agent may have exited in between. And
	// read through HasPosition, so a residue left by an earlier exit is not
	// mistaken for something to sell — a guard that fires on a wei spends a
	// real approval and a real swap to move nothing.
	units, uerr := e.broker.UnitsOf(ctx, wallet.Address, g.Symbol)
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
	//
	// The scan price decided to look; this price decides to act. Between them
	// sits a lease acquisition and two chain reads, and a level that has
	// stopped being crossed in that time has not been crossed.
	price, perr := e.broker.RealizablePrice(ctx, wallet.Address, g.Symbol, units)
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

	// 4. THE COST METER, which can refuse this.
	//
	// AND IT SHOULD. A brake with an exception is not a brake, and this is the
	// path most likely to be argued into one: nobody wants to be the reason a
	// stop loss did not fire. But an agent past its cost budget is an agent
	// whose trading is already costing more than its owner agreed to, and the
	// signer would refuse the signature anyway once the daily cap ran out — a
	// hole here would not save the exit, only hide why it did not happen.
	//
	// So it refuses, the refusal is RECORDED as a decision, and the guard stays
	// ARMED. Nothing is silently consumed: when the budget frees, the level is
	// still watching.
	//
	// The refusal is also remembered on the guard row, which is what
	// arcana-guard-watchdog alarms on — an owner whose stop loss is being held
	// back by their own budget needs to know today. An earlier version of this
	// comment claimed the alarm existed before it did; it exists now.
	// THE OWNER'S BUDGET, READ FROM THE OWNER'S PROFILE. An agent that set no
	// cost brake has none here either: a protective exit must not be subject to
	// a limit its owner never asked for, and must not escape one they did.
	// Resolved with the subject above, so the brake and the wallet it guards
	// always come from the same place.
	cv := e.checkCostFor(ctx, subj.Meter, subj.Budget)
	if cv.pause {
		// RECORDED ONCE, NOT ONCE PER SCAN.
		//
		// The first version wrote a decision here every time, and the guard
		// rescans every fifteen seconds: fifty-seven identical rows in fifteen
		// minutes, 240 an hour. Every row was true and together they were a lie
		// of a different kind — `decisions` is what every read model counts to
		// decide whether an agent has competed, so a condition sampled
		// repeatedly made a stuck agent look like a busy one.
		//
		// A persisting refusal is one fact. It is remembered on the GUARD, and
		// the decision log gets the first one.
		prev, had, rerr := e.store.LastRefusal(ctx, g.ID)
		if rerr != nil {
			log.Printf("agent %s: guard %d refusal state unreadable, recording this one: %v",
				g.AgentID, g.ID, rerr)
		}
		// A refusal that has already been recorded is re-stated once a day, so
		// an owner whose stop loss has been held back for a week can see that it
		// is still held back rather than reading one row from last Tuesday.
		fresh := !had || prev.Reason != cv.reason || time.Since(prev.At) > 24*time.Hour

		var id int64
		if fresh {
			var derr error
			id, derr = e.recordProtective(ctx, g, "hold", nil, ReasonCostBudget, fmt.Sprintf(
				"%s at %.6f crossed the %s level, and the exit was NOT taken: %s. The level stays "+
					"armed and will be acted on once the agent is inside its budget again",
				g.Symbol, price, t.Side, cv.detail), nil)
			if derr != nil {
				return ProtectiveOutcome{}, derr
			}
		}
		var idPtr *int64
		if id != 0 {
			idPtr = &id
		}
		if nerr := e.store.NoteRefusal(ctx, g.ID, cv.reason, idPtr); nerr != nil {
			log.Printf("ERROR agent %s: guard %d refusal not remembered, so it will be recorded "+
				"again on the next scan: %v", g.AgentID, g.ID, nerr)
		}
		note := "the cost meter refused the exit; the guard stays armed"
		if !fresh {
			note += " (already recorded; not re-recorded on every scan)"
		}
		return ProtectiveOutcome{DecisionID: id, Status: "cost_blocked", Note: note}, nil
	}
	// The guard can act, so any earlier refusal has ended. Forgetting it means a
	// refusal that comes back is recorded as the new fact it is.
	if rerr := e.store.ClearRefusal(ctx, g.ID); rerr != nil {
		log.Printf("agent %s: guard %d refusal state not cleared: %v", g.AgentID, g.ID, rerr)
	}

	// 5. THE EXIT, through the ordinary path.
	//
	// The same settleOnChain every decision uses: the same drift check, the
	// same execution row, the same separate approval row, the same signer. The
	// quantity is the whole position, so exitUnits sends the integer balance
	// and the position closes with nothing left behind.
	seasonID, serr := e.store.SeasonOfAgent(ctx, g.AgentID)
	if serr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("season for %s: %w", g.AgentID, serr)
	}
	ref, rerr := e.store.LatestSnapshotRef(ctx)
	if rerr != nil {
		return ProtectiveOutcome{}, fmt.Errorf("snapshot ref: %w", rerr)
	}
	portfolio, _, prices, lerr := e.loadState(ctx, g.AgentID, seasonID, ref)
	if lerr != nil {
		return ProtectiveOutcome{}, lerr
	}

	req := ExecuteRequest{
		AgentID: g.AgentID, SeasonID: seasonID,
		Timestamp: time.Now().UTC(), MarketSnapshotRef: ref,
	}
	intent := tradeIntent{
		Action: "sell", Symbol: g.Symbol, Quantity: shares,
		Rationale: protectiveRationale(g, t, ref),
	}
	ev := Evidence{Decider: DeciderProtective, ReasonCode: reasonFor(t.Side)}

	set, cerr := e.settleOnChain(ctx, req, portfolio.ID, wallet, intent,
		prices, portfolio.Holdings, parseMoney(portfolio.Cash), ev)
	if cerr != nil {
		return ProtectiveOutcome{}, cerr
	}
	// settleOnChain sets execution_<status> on the evidence, which is true and
	// is not the thing this decision needs to be findable by. The reason code
	// is what fired; the execution status is already in the rationale and in
	// the execution row.
	set.Ev.Decider = DeciderProtective
	set.Ev.ReasonCode = reasonFor(t.Side)

	id, derr := e.recordProtectiveSettlement(ctx, req, portfolio.ID, prices, set)
	if derr != nil {
		return ProtectiveOutcome{}, derr
	}

	// 6. CLOSE THE GUARD, and only on a real exit.
	//
	// A reverted or unresolved attempt leaves the level ARMED. The position is
	// still there and still past the level, so the protection is still wanted;
	// marking it triggered would quietly disarm a stop loss because one
	// transaction failed.
	if set.Action == "sell" {
		// The execution names the instruction that caused it. The creator's
		// settlement path has no use for a guard id and is not taught one; the
		// link is made here, once the guard is known to have fired, the same way
		// the decision id is attached after the fact.
		if set.ExecID != nil {
			if lerr := e.store.LinkExecutionToGuard(ctx, *set.ExecID, g.ID); lerr != nil {
				log.Printf("ERROR agent %s: execution %d not linked to guard %d: %v",
					g.AgentID, *set.ExecID, g.ID, lerr)
			}
		}
		ok, cerr := e.store.CloseGuard(ctx, g.ID, "triggered", t.Side, &t.Price, &id, fmt.Sprintf(
			"%s exit executed at %.6f against a level of %.6f", t.Side, t.Price, levelOf(g, t.Side)))
		if cerr != nil {
			log.Printf("ERROR agent %s: guard %d fired and was not closed: %v", g.AgentID, g.ID, cerr)
		} else if !ok {
			log.Printf("agent %s: guard %d was already closed by somebody else", g.AgentID, g.ID)
		}
		return ProtectiveOutcome{Executed: true, DecisionID: id, Status: set.Action,
			Note: set.Rationale}, nil
	}

	log.Printf("agent %s: protective exit on %s did not complete (%s); the guard stays armed",
		g.AgentID, g.Symbol, set.Action)
	return ProtectiveOutcome{DecisionID: id, Status: set.Action, Note: set.Rationale}, nil
}

func reasonFor(side string) string {
	if side == "stop_loss" {
		return ReasonStopLoss
	}
	return ReasonTakeProfit
}

func levelOf(g store.Guard, side string) float64 {
	if side == "stop_loss" && g.StopLoss != nil {
		return *g.StopLoss
	}
	if g.TakeProfit != nil {
		return *g.TakeProfit
	}
	return 0
}

// protectiveRationale says what fired, at what price, against what level, set
// when — and names the price it actually used.
//
// THE SNAPSHOT REF IS NAMED AS NOT BEING THE INPUT. decisions.market_snapshot_ref
// is NOT NULL and a foreign key, so a protective decision has to carry one. But
// this decision was not made from a snapshot: it was made from a pool quote
// taken seconds earlier. Saying so in the rationale is the difference between a
// record that is complete and one that implies an input that did not exist.
func protectiveRationale(g store.Guard, t Trigger, ref string) string {
	what := "stop loss"
	if t.Side == "take_profit" {
		what = "take profit"
	}
	return fmt.Sprintf(
		"%s: %s realizable at %.6f, crossing the %.6f level set at entry %.6f on %s. "+
			"Decided by no one: the level was armed when the position opened and this is a "+
			"price crossing it. The price is a pool quote for the whole position taken now; "+
			"snapshot %s is the nearest recorded tick and was NOT the input",
		what, g.Symbol, t.Price, levelOf(g, t.Side), g.EntryPrice,
		g.SetAt.UTC().Format(time.RFC3339), ref)
}

// recordProtective writes a protective decision that did NOT trade.
//
// Used for the cost-meter refusal. It writes no portfolio snapshot: nothing
// moved, so marking to market here would produce a row that differs from the
// last one only by its timestamp.
func (e *Engine) recordProtective(ctx context.Context, g store.Guard, action string,
	qty *float64, reason, rationale string, execID *int64) (int64, error) {

	seasonID, err := e.store.SeasonOfAgent(ctx, g.AgentID)
	if err != nil {
		return 0, fmt.Errorf("season for %s: %w", g.AgentID, err)
	}
	ref, err := e.store.LatestSnapshotRef(ctx)
	if err != nil {
		return 0, fmt.Errorf("snapshot ref: %w", err)
	}
	ts := time.Now().UTC()
	id, err := e.store.AppendDecision(ctx, store.DecisionInsert{
		AgentID: g.AgentID, SeasonID: seasonID, TS: ts, MarketSnapshotRef: ref,
		Action: action, Symbol: g.Symbol, Quantity: moneyPtr(qty),
		Rationale: rationale,
	})
	if err != nil {
		return 0, err
	}
	if err := e.store.AttachEvidence(ctx, id, g.AgentID, ts, store.DecisionEvidence{
		Decider: DeciderProtective, ReasonCode: reason,
	}); err != nil {
		log.Printf("ERROR protective decision %d recorded without its evidence: %v", id, err)
	}
	if execID != nil {
		if err := e.store.LinkExecutionToDecision(ctx, *execID, id); err != nil {
			log.Printf("ERROR execution %d not linked to protective decision %d: %v", *execID, id, err)
		}
	}
	return id, nil
}

// recordProtectiveSettlement persists an exit that reached the chain.
//
// Deliberately the same persist() and the same evidence write the ordinary path
// uses: one place decides what a decision row looks like, so a protective one
// cannot drift into a different shape.
func (e *Engine) recordProtectiveSettlement(ctx context.Context, req ExecuteRequest,
	portfolioID string, prices map[string]float64, set settlement) (int64, error) {

	id, err := e.persist(ctx, req, portfolioID, set.Action, set.Symbol, set.Qty,
		set.Holdings, set.Cash, prices, set.Rationale)
	if err != nil {
		return 0, err
	}
	if set.ExecID != nil {
		if err := e.store.LinkExecutionToDecision(ctx, *set.ExecID, id); err != nil {
			log.Printf("ERROR execution %d recorded but not linked to decision %d: %v", *set.ExecID, id, err)
		}
	}
	if err := e.store.AttachEvidence(ctx, id, req.AgentID, req.Timestamp, toStoreEvidence(set.Ev)); err != nil {
		log.Printf("ERROR protective decision %d recorded without its evidence: %v", id, err)
	}
	return id, nil
}

// ScanOnce reads every armed guard, prices each one, and acts on those whose
// level is crossed. It is the whole of what the watcher does.
//
// PRICING IS FREE AND ACTING IS NOT. Every guard costs one eth_call per scan
// and nothing else. Gas is spent only inside ExecuteProtective, and only after
// the position, the price and the budget have each been checked again.
func (e *Engine) ScanOnce(ctx context.Context) (armed int, fired int, firstErr error) {
	guards, err := e.store.ArmedGuards(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("read armed guards: %w", err)
	}
	armed = len(guards)

	for _, g := range guards {
		// THE WALLET IS PER GUARD, not per agent. One agent's armed guards can
		// now name several different accounts, and pricing a buyer's level
		// against the creator's balance would be a stop loss watching a position
		// that is not the one it protects.
		subj, stand, serr := e.guardSubjectFor(ctx, g)
		if serr != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("resolve guard %d: %w", g.ID, serr)
			}
			continue
		}
		if stand != nil {
			// Acted on HERE rather than left for the trigger path: a mandate
			// that has ended must stop a level from watching whether or not a
			// price ever crosses it, and a scan that skipped it silently would
			// leave an armed row over a wallet nobody is allowed to sign for.
			out, _ := e.standDown(ctx, g, *stand)
			if out.Status == "expired" {
				armed--
			}
			continue
		}
		units, uerr := e.broker.UnitsOf(ctx, subj.Wallet, g.Symbol)
		if uerr != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("read %s for %s: %w", g.Symbol, subj.Who, uerr)
			}
			continue
		}
		// DUST TRIGGERS NOTHING. Checked before the price is even asked for, so
		// a residue costs not even an eth_call.
		shares := unitsToShares(units, e.broker.DecimalsOf(g.Symbol))
		if !HasPosition(map[string]any{g.Symbol: shares}, g.Symbol) {
			_, _ = e.store.CloseGuard(ctx, g.ID, "expired", "", nil, nil, fmt.Sprintf(
				"nothing left to guard: %s base units of %s is below the recordable floor",
				units.String(), g.Symbol))
			armed--
			continue
		}
		price, perr := e.broker.RealizablePrice(ctx, subj.Wallet, g.Symbol, units)
		if perr != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("price %s for %s: %w", g.Symbol, subj.Who, perr)
			}
			continue
		}
		side := crossed(struct{ TakeProfit, StopLoss *float64 }{g.TakeProfit, g.StopLoss}, price)
		if side == "" {
			continue
		}

		log.Printf("guard %d (%s): %s %s crossed at %.6f (entry %.6f)",
			g.ID, subj.Who, g.Symbol, side, price, g.EntryPrice)
		out, xerr := e.ExecuteProtective(ctx, Trigger{Guard: g, Side: side, Price: price})
		if xerr != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("exit %s for %s: %w", g.Symbol, subj.Who, xerr)
			}
			continue
		}
		log.Printf("guard %d: %s (%s)", g.ID, out.Status, out.Note)
		if out.Executed {
			fired++
		}
	}
	return armed, fired, firstErr
}
