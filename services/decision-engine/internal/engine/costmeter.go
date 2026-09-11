package engine

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

// The transaction cost meter.
//
// WHOSE BRAKE THIS IS. The owner's. Not the platform's, and it was the
// platform's for about a day.
//
// It measures what an agent has spent on gas and pool fees against the capital
// it is being taken from — the only measurement in the system that can tell a
// cheap agent from an expensive one, because everything else bounds a count or
// a size and none of those know what has already been spent.
//
// That measurement is worth having and the pause it can produce is worth
// having. What was wrong was WHO SET IT. A platform-set percentage decides for
// an owner how expensive a trading style they are allowed to have, and on a
// small book it bites immediately: at $11.76 of capital a 2% monthly budget
// permits about three and a half transactions a month. That arithmetic is true
// and it is the owner's to act on — by adding capital, trading less often, or
// accepting the cost — not the platform's to enforce.
//
// So: MonthlyPct comes from the agent's own risk_profile
// (`cost_budget_monthly_pct`), zero means unmetered, and zero is the default.
// An agent whose owner has not asked for a cost brake does not have one.
//
// WHAT DID NOT MOVE WITH IT. The inference token meter stays platform-side: an
// LLM call spends the platform's money, not the owner's. The signature cap
// stays platform-side: it bounds how much of the platform's capacity one agent
// may consume. Those are ours. This one is not.
//
// TWO RULES, because one cannot cover both shapes of the problem.
//
//	SUSTAINED   the projected monthly rate exceeds the budget. Needs a real
//	            sample: three executions and a day of history. Projecting a
//	            month from twenty minutes is not measurement, and pausing on it
//	            would make the meter a coin toss for every new agent.
//
//	RUNAWAY     a whole month's budget spent inside twenty-four hours. Needs no
//	            history at all, because no sample is required to see that the
//	            allowance is gone.
//
// Neither rule looks at whether the agent made money. A profitable agent paying
// 40% a month in costs is still an agent whose costs need saying out loud.
type costMeter struct {
	// MonthlyPct is the share of capital an agent may spend on gas and pool
	// fees per 30 days. Zero disables the meter.
	MonthlyPct float64
	// MinExecutions and MinSpan are what the SUSTAINED rule needs before it
	// will trust its own projection.
	MinExecutions int
	MinSpan       time.Duration
	// Window is how far back costs are summed.
	Window time.Duration
}

func defaultCostMeter(pct float64) costMeter {
	return costMeter{
		MonthlyPct:    pct,
		MinExecutions: 3,
		MinSpan:       24 * time.Hour,
		Window:        30 * 24 * time.Hour,
	}
}

// costVerdict is what the meter concluded, and enough of the arithmetic to put
// in the record. A refusal that does not show its working is one nobody can act
// on.
type costVerdict struct {
	pause   bool
	reason  string
	detail  string
	spentUS float64
	capital float64
	rate    float64 // projected monthly, as a fraction of capital
}

// ReasonCostBudget is recorded on a decision the meter paused.
const ReasonCostBudget = "cost_budget_exceeded"

// costSubject is WHOSE money the meter is measuring.
//
// ONE PIECE OF ARITHMETIC, TWO SUBJECTS. A creator's wallet and a buyer's
// wallet are metered the same way — spend over a window, projected against
// capital — and the only differences are which rows count as spending and which
// snapshot is the capital. Duplicating the projection for subscribers would
// eventually mean two meters disagreeing about what a runaway is, and the
// disagreement would be somebody's money.
type costSubject struct {
	// noun is how the refusal refers to whoever is being metered.
	noun string
	// hint names where the budget that refused this can be changed. It is the
	// owner's own setting in both cases, never the platform's.
	hint    string
	cost    func(context.Context, time.Time) (store.CostWindow, error)
	capital func(context.Context) (float64, bool, error)
}

// agentSubject meters the creator's own wallet.
func (e *Engine) agentSubject(agentID string) costSubject {
	return costSubject{
		noun: "this agent",
		hint: "raise cost_budget_monthly_pct in this agent's risk_profile",
		cost: func(ctx context.Context, since time.Time) (store.CostWindow, error) {
			return e.store.CostSince(ctx, agentID, since)
		},
		capital: func(ctx context.Context) (float64, bool, error) {
			return e.store.CapitalOf(ctx, agentID)
		},
	}
}

// subscriptionSubject meters one buyer's wallet, against one buyer's book.
func (e *Engine) subscriptionSubject(subID string) costSubject {
	return costSubject{
		noun: "this subscription",
		hint: "raise cost_budget_monthly_pct in this subscription's risk_profile, " +
			"or add funds to the wallet",
		cost: func(ctx context.Context, since time.Time) (store.CostWindow, error) {
			return e.store.CostSinceSubscription(ctx, subID, since)
		},
		capital: func(ctx context.Context) (float64, bool, error) {
			return e.store.CapitalOfSubscription(ctx, subID)
		},
	}
}

// checkCost asks whether this agent may still spend.
//
// AN UNREADABLE COST PAUSES. If an execution moved funds and its dollar cost
// was never recorded — the price feed was down when it happened — the meter
// cannot know what has been spent, and carrying on would mean measuring a
// wallet with an unknown amount already missing from it. Same rule as an
// unreadable blocklist and an unreadable signature count.
// pct is the agent's own budget, from its risk_profile. Passed in rather than
// read from the Engine so there is no way to apply one agent's brake to another,
// and no configuration under which the platform supplies one nobody asked for.
func (e *Engine) checkCost(ctx context.Context, agentID string, pct float64) costVerdict {
	return e.checkCostFor(ctx, e.agentSubject(agentID), pct)
}

// checkCostFor is the meter itself, for whichever wallet it is pointed at.
func (e *Engine) checkCostFor(ctx context.Context, subj costSubject, pct float64) costVerdict {
	m := e.cost
	m.MonthlyPct = pct
	if m.MonthlyPct <= 0 {
		// UNMETERED, which is the default. Not a degraded mode and not a
		// failure: the owner has not asked for a cost brake.
		return costVerdict{}
	}

	w, err := subj.cost(ctx, time.Now().Add(-m.Window))
	if err != nil {
		return costVerdict{
			pause:  true,
			reason: ReasonCostBudget,
			detail: fmt.Sprintf("the cost record could not be read (%v), so what %s has "+
				"already spent is unknown. Refusing rather than treating an unreadable bill as a "+
				"paid one", err, subj.noun),
		}
	}
	if w.Unpriced > 0 {
		return costVerdict{
			pause:  true,
			reason: ReasonCostBudget,
			detail: fmt.Sprintf("%d execution(s) in the last %s moved funds with no dollar cost "+
				"recorded, because the ETH price feed could not be read at the time. The bill is "+
				"incomplete, so the budget cannot be checked against it",
				w.Unpriced, m.Window),
		}
	}

	capital, ok, cerr := subj.capital(ctx)
	if cerr != nil {
		// UNREADABLE CAPITAL PAUSES. The first version discarded this error and
		// fell through to the no-snapshot branch, which permits -- so a meter
		// that could not read the capital let everything through instead of
		// stopping it.
		return costVerdict{
			pause:  true,
			reason: ReasonCostBudget,
			detail: fmt.Sprintf("the capital %s is being measured against could not be "+
				"read (%v), so no budget can be applied to it", subj.noun, cerr),
		}
	}
	if !ok {
		// No snapshot yet: nothing has been marked to market, so there is no
		// capital to measure against. Not a pause — an agent that has never
		// traded has spent nothing, and its first tick must be allowed to
		// create the snapshot this needs.
		return costVerdict{}
	}

	v := costVerdict{spentUS: w.USD, capital: capital}

	// RUNAWAY: a month's allowance gone inside a day.
	monthlyBudget := capital * m.MonthlyPct / 100
	day, err := subj.cost(ctx, time.Now().Add(-24*time.Hour))
	if err == nil && monthlyBudget > 0 && day.USD > monthlyBudget {
		v.pause = true
		v.reason = ReasonCostBudget
		v.rate = day.USD / capital * 100 * 30
		v.detail = fmt.Sprintf(
			"spent $%.4f in the last 24h against a monthly budget of $%.4f (%.1f%% of $%.2f "+
				"capital). A month's allowance in a day is not a rate to project, it is one to stop. "+
				"Add capital, lengthen the cadence, or %s. The budget is the owner's; the platform "+
				"sets none",
			day.USD, monthlyBudget, m.MonthlyPct, capital, subj.hint)
		return v
	}

	// SUSTAINED: only once there is a sample worth projecting from.
	if w.Executions < m.MinExecutions || w.Span < m.MinSpan {
		return v
	}
	days := w.Span.Hours() / 24
	if days <= 0 {
		return v
	}
	monthly := w.USD * (30 / days)
	v.rate = monthly / capital * 100
	if v.rate > m.MonthlyPct {
		needed := monthly / (m.MonthlyPct / 100)
		v.pause = true
		v.reason = ReasonCostBudget
		v.detail = fmt.Sprintf(
			"$%.4f of gas and pool fees over %.1f days projects to $%.4f a month, which is %.2f%% "+
				"of $%.2f capital against a budget of %.1f%%. This cadence needs about $%.0f of "+
				"capital to fit the budget, or the cadence has to lengthen. Costs are mostly fixed "+
				"per transaction, so a smaller book pays a larger share of itself",
			w.USD, days, monthly, v.rate, capital, m.MonthlyPct, needed)
	}
	return v
}

// logCostVerdict says what the meter concluded even when it permits, so the
// number is visible before it becomes a refusal.
func logCostVerdict(agentID string, v costVerdict) {
	if v.capital <= 0 {
		return
	}
	if v.pause {
		log.Printf("cost meter PAUSED agent %s: %s", agentID, v.detail)
		return
	}
	if v.rate > 0 {
		log.Printf("cost meter: agent %s at %.2f%% of capital per month ($%.4f spent, $%.2f capital)",
			agentID, v.rate, v.spentUS, v.capital)
	}
}
