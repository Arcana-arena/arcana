// Package credit turns an agent's capital record into a reputation, and the
// reputation into a tier. architecture.md §18.
//
// IT HOLDS NO KEY, READS NO CHAIN AND WRITES NO ROW, like package capital. The
// engine gives it readings and events; it answers with cycles, a score and a
// tier, and the same inputs always give the same answer. No model is asked
// anything.
//
// THREE STEPS, EACH ONE READABLE ON ITS OWN:
//
//	BuildCycles  the readings of a position, cut into loans. A cycle opens when
//	             debt appears and closes when it is gone.
//	Score        0–100 from the cycles, or UNRATED when there is not enough
//	             history to say anything.
//	TierFor      the score against the allowlist's tier table, then the gates a
//	             score cannot talk its way past.
//
// NOTHING HERE ENTERS THE ARCANA SCORE (§17.3), and the ARCANA Score is not a
// term in this one: a scored track record is a GATE on the higher tiers and
// nothing else. Two dimensions that share inputs are one dimension printed
// twice.
package credit

import (
	"math"
	"sort"
	"time"
)

// Floor is the lowest health-factor floor a mandate may set (migration 0059,
// capital_mandates_hf_ck). Margin is measured against it and not against the
// agent's own mandate, so an owner cannot improve the measurement by lowering
// the bar it is taken against.
const Floor = 1.5

// A cycle counts as evidence only above these. Without them fourteen loans of
// one USDG held for a minute would buy the record of fourteen loans.
const (
	QualifyingPeakUSDG = 10.0
	QualifyingDuration = 24 * time.Hour
)

// Under this much history the agent is UNRATED, whatever happened inside it.
const MinHistory = 30 * 24 * time.Hour

// How long a failure holds the tier at zero. The liquidation itself stays on
// the record permanently; this is only how long it decides the tier.
const (
	LiquidationHold = 90 * 24 * time.Hour
	StuckHold       = 30 * 24 * time.Hour
)

// The weights. PROPOSED, NOT CALIBRATED: on the day they were written one agent
// had ever borrowed (architecture.md §18.1). They are constants in one place so
// that changing them is one reviewed diff.
const (
	WeightExposure        = 35.0
	WeightMargin          = 30.0
	WeightSelfSufficiency = 20.0
	WeightCyclesClosed    = 15.0

	// USDG-days at which exposure stops adding evidence: 250 USDG carried for a
	// hundred days, or 1,000 for twenty-five.
	ExposureFullUSDGDays = 25000.0
	// Deleverage steps per 30 days of debt at which self-sufficiency is zero.
	DeleverageRateZero = 4.0
	// Cycles closed by repayment at which that component is full.
	CyclesClosedFull = 12.0
)

// Reading is one capital_positions row: what the chain said at a moment.
type Reading struct {
	TS      time.Time
	Debt    float64
	HFWorst *float64 // nil when nothing is owed
}

// Flow is a mined borrow or repay recorded in capital_actions.
type Flow struct {
	TS     time.Time
	Borrow bool
	Amount float64
}

// Cycle is one loan.
type Cycle struct {
	OpenedAt          time.Time
	ClosedAt          *time.Time
	PeakDebt          float64
	USDGDays          float64
	DebtSeconds       float64
	SecondsUnderFloor float64
	LowestHFWorst     *float64
	Borrowed          float64
	Repaid            float64
	// Repaid less borrowed, once closed; nil while open.
	Interest        *float64
	DeleverageSteps int
	Liquidations    int
	// "repaid", "deleveraged" or "liquidated"; "" while open.
	ClosedHow string
}

// Duration is how long the cycle has run, to its close or to now.
func (c Cycle) Duration(now time.Time) time.Duration {
	if c.ClosedAt != nil {
		return c.ClosedAt.Sub(c.OpenedAt)
	}
	return now.Sub(c.OpenedAt)
}

// Qualifying reports whether the cycle is large and long enough to be evidence.
func (c Cycle) Qualifying(now time.Time) bool {
	return c.PeakDebt >= QualifyingPeakUSDG && c.Duration(now) >= QualifyingDuration
}

// BuildCycles cuts a position's readings into cycles and attributes the flows,
// deleverage steps and liquidations to them.
//
// THE READINGS DECIDE WHERE A CYCLE STARTS AND ENDS, not the actions: a reading
// is what the chain said, and it sees a repayment made with the owner's own key
// that no capital_actions row records. Debt between two readings is taken to be
// the earlier one's — a reader that stopped for an hour still leaves an hour of
// debt on the record, because the debt did not stop.
//
// AN EVENT BELONGS TO THE CYCLE IT HAPPENED IN OR JUST BEFORE. A borrow is
// mined up to a scan before the first reading that shows it, so events are
// attributed to the first cycle that had not yet closed when they happened.
func BuildCycles(readings []Reading, flows []Flow, deleverages, liquidations []time.Time) []Cycle {
	rs := append([]Reading(nil), readings...)
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].TS.Before(rs[j].TS) })

	var out []Cycle
	var open *Cycle
	var prev Reading
	for i, r := range rs {
		if open != nil && i > 0 {
			dt := r.TS.Sub(prev.TS).Seconds()
			if dt > 0 {
				open.USDGDays += prev.Debt * dt / 86400
				open.DebtSeconds += dt
				if prev.HFWorst != nil && *prev.HFWorst < Floor {
					open.SecondsUnderFloor += dt
				}
			}
		}
		switch {
		case r.Debt > 0:
			if open == nil {
				open = &Cycle{OpenedAt: r.TS}
			}
			if r.Debt > open.PeakDebt {
				open.PeakDebt = r.Debt
			}
			if r.HFWorst != nil && (open.LowestHFWorst == nil || *r.HFWorst < *open.LowestHFWorst) {
				v := *r.HFWorst
				open.LowestHFWorst = &v
			}
		case open != nil:
			at := r.TS
			open.ClosedAt = &at
			out = append(out, *open)
			open = nil
		}
		prev = r
	}
	if open != nil {
		out = append(out, *open)
	}

	// The first cycle not yet closed at t. An event after the final close
	// belongs to no cycle yet: the reading that opens its cycle has not come.
	at := func(t time.Time) *Cycle {
		for i := range out {
			if out[i].ClosedAt == nil || !t.After(*out[i].ClosedAt) {
				return &out[i]
			}
		}
		return nil
	}
	for _, f := range flows {
		if c := at(f.TS); c != nil {
			if f.Borrow {
				c.Borrowed += f.Amount
			} else {
				c.Repaid += f.Amount
			}
		}
	}
	for _, t := range deleverages {
		if c := at(t); c != nil {
			c.DeleverageSteps++
		}
	}
	for _, t := range liquidations {
		if c := at(t); c != nil {
			c.Liquidations++
		}
	}
	for i := range out {
		c := &out[i]
		if c.ClosedAt == nil {
			continue
		}
		switch {
		case c.Liquidations > 0:
			c.ClosedHow = "liquidated"
		case c.DeleverageSteps > 0:
			c.ClosedHow = "deleveraged"
		default:
			c.ClosedHow = "repaid"
		}
		interest := math.Max(0, c.Repaid-c.Borrowed)
		c.Interest = &interest
	}
	return out
}

// Components are the four parts of the score, in points.
type Components struct {
	Exposure        float64 `json:"exposure"`
	Margin          float64 `json:"margin"`
	SelfSufficiency float64 `json:"self_sufficiency"`
	CyclesClosed    float64 `json:"cycles_closed"`
}

// Inputs are the figures the components were computed from.
type Inputs struct {
	Cycles            int      `json:"cycles"`
	QualifyingCycles  int      `json:"qualifying_cycles"`
	CyclesRepaid      int      `json:"cycles_repaid"`
	USDGDays          float64  `json:"usdg_days"`
	DebtDays          float64  `json:"debt_days"`
	ShareUnderFloor   float64  `json:"share_under_floor"`
	LowestHFWorst     *float64 `json:"lowest_health_factor_worst"`
	DeleverageSteps   int      `json:"deleverage_steps"`
	Liquidations      int      `json:"liquidations"`
	HistoryDays       float64  `json:"history_days"`
	EvidenceFraction  float64  `json:"evidence_fraction"`
	MarginQuality     float64  `json:"margin_quality"`
	SelfSufficiencyQ  float64  `json:"self_sufficiency_quality"`
	DeleverageRate30d float64  `json:"deleverage_steps_per_30_debt_days"`
}

// Result is a reputation. Score is meaningful only when Rated.
type Result struct {
	Rated      bool
	UnratedWhy string
	Score      int
	Components Components
	Inputs     Inputs
}

// Score computes the reputation from every cycle the agent has, in every
// market.
//
// A CLEAN RECORD ON A SMALL LOAN IS WEAK EVIDENCE. Margin and self-sufficiency
// are scaled by the same evidence fraction as exposure, so "nothing went wrong"
// is worth as much as there was that could have gone wrong. Without that, one
// small loan held safely for a month scored within a few points of a year of
// real borrowing.
func Score(cycles []Cycle, now time.Time) Result {
	var res Result
	in := &res.Inputs
	in.Cycles = len(cycles)

	var first *time.Time
	var debtSeconds, underFloor float64
	for _, c := range cycles {
		if first == nil || c.OpenedAt.Before(*first) {
			t := c.OpenedAt
			first = &t
		}
		debtSeconds += c.DebtSeconds
		underFloor += c.SecondsUnderFloor
		in.DeleverageSteps += c.DeleverageSteps
		in.Liquidations += c.Liquidations
		if c.LowestHFWorst != nil && (in.LowestHFWorst == nil || *c.LowestHFWorst < *in.LowestHFWorst) {
			v := *c.LowestHFWorst
			in.LowestHFWorst = &v
		}
		if c.Qualifying(now) {
			in.QualifyingCycles++
			in.USDGDays += c.USDGDays
			if c.ClosedHow == "repaid" {
				in.CyclesRepaid++
			}
		}
	}
	in.DebtDays = debtSeconds / 86400
	if first != nil {
		in.HistoryDays = now.Sub(*first).Hours() / 24
	}

	switch {
	case first == nil:
		res.UnratedWhy = "this agent has never borrowed"
		return res
	case now.Sub(*first) < MinHistory:
		res.UnratedWhy = "less than 30 days since its first borrow"
		return res
	case in.QualifyingCycles == 0:
		res.UnratedWhy = "no loan of at least 10 USDG held for at least 24 hours"
		return res
	}
	res.Rated = true

	in.EvidenceFraction = clamp(math.Log1p(in.USDGDays/100) / math.Log1p(ExposureFullUSDGDays/100))

	if debtSeconds > 0 {
		in.ShareUnderFloor = underFloor / debtSeconds
		depth := 1.0
		if in.LowestHFWorst != nil && *in.LowestHFWorst < Floor {
			// Liquidation is at 1.0: a low of 1.25 is half way there.
			depth = clamp((*in.LowestHFWorst - 1) / (Floor - 1))
		}
		in.MarginQuality = (1 - in.ShareUnderFloor) * depth

		in.DeleverageRate30d = float64(in.DeleverageSteps) / (in.DebtDays / 30)
		in.SelfSufficiencyQ = clamp(1 - in.DeleverageRate30d/DeleverageRateZero)
	}

	c := &res.Components
	c.Exposure = WeightExposure * in.EvidenceFraction
	c.Margin = WeightMargin * in.MarginQuality * in.EvidenceFraction
	c.SelfSufficiency = WeightSelfSufficiency * in.SelfSufficiencyQ * in.EvidenceFraction
	c.CyclesClosed = WeightCyclesClosed * clamp(float64(in.CyclesRepaid)/CyclesClosedFull)
	res.Score = int(math.Round(c.Exposure + c.Margin + c.SelfSufficiency + c.CyclesClosed))
	return res
}

func clamp(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// Tier is one row of the allowlist's tier table.
type Tier struct {
	Tier          int
	MinScore      int
	MaxDebtUSDG   float64
	MinScoredDays int // days of scored trading record the tier requires; 0 for none
}

// Standing is the tier an agent holds and why it is not higher.
type Standing struct {
	EarnedTier  int    // what the score alone gives
	Tier        int    // what the agent holds
	HeldBecause string // "", "liquidation", "deleverage_stuck" or "performance_gate"
}

// TierFor applies the tier table and then the gates.
//
// THE GATES ARE NOT WEIGHTS. A liquidation is not averaged away by a long clean
// record before it: for LiquidationHold it puts the agent at tier 0, whatever
// the score. A deleverage the guard could not carry out does the same for a
// shorter time. And a tier that requires a scored trading record is not reached
// without one — the ARCANA Score gates the tier and is not added to the score.
func TierFor(r Result, tiers []Tier, scoredDays float64, liquidations, stuck []time.Time, now time.Time) Standing {
	var s Standing
	if !r.Rated {
		return s
	}
	gated := false
	for _, t := range tiers {
		if r.Score < t.MinScore {
			continue
		}
		if t.Tier > s.EarnedTier {
			s.EarnedTier = t.Tier
		}
		if scoredDays < float64(t.MinScoredDays) {
			gated = true
			continue
		}
		if t.Tier > s.Tier {
			s.Tier = t.Tier
		}
	}
	if gated && s.Tier < s.EarnedTier {
		s.HeldBecause = "performance_gate"
	}
	if within(stuck, StuckHold, now) && s.EarnedTier > 0 {
		s.Tier, s.HeldBecause = 0, "deleverage_stuck"
	}
	if within(liquidations, LiquidationHold, now) {
		s.Tier = 0
		if s.EarnedTier > 0 {
			s.HeldBecause = "liquidation"
		}
	}
	return s
}

func within(events []time.Time, hold time.Duration, now time.Time) bool {
	for _, t := range events {
		if now.Sub(t) < hold {
			return true
		}
	}
	return false
}

// StaleAfter is how old a reputation may be before it stops granting anything.
// The guard recomputes it at least twice a day; a row two days old means the
// guard has stopped, and a tier nobody has re-checked is tier 0. Could not
// check is not the same as fine.
const StaleAfter = 48 * time.Hour

// Limit is the debt limit, in whole USDG, for an agent holding `tier` as of
// `computedAt`.
//
// WITH CREDIT DISABLED EVERY AGENT HAS THE PLATFORM'S CAP, exactly as before
// §18 existed. With it enabled the limit is the tier's, never above the
// platform's ceiling, and tier 0 for a reputation that is missing or stale.
func Limit(enabled bool, tiers []Tier, ceilingUSDG float64, tier int, computedAt *time.Time, now time.Time) float64 {
	if !enabled || len(tiers) == 0 {
		return ceilingUSDG
	}
	if computedAt == nil || now.Sub(*computedAt) > StaleAfter {
		tier = 0
	}
	limit := 0.0
	for _, t := range tiers {
		if t.Tier == 0 || t.Tier == tier {
			limit = math.Max(limit, t.MaxDebtUSDG)
		}
	}
	return math.Min(limit, ceilingUSDG)
}
