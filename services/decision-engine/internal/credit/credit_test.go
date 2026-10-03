package credit

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

func at(d time.Duration) time.Time { return t0.Add(d) }
func hf(v float64) *float64        { return &v }

const day = 24 * time.Hour

// loan is a run of hourly readings with one debt and one health factor,
// followed by the reading that finds it repaid.
func loan(start time.Duration, days int, debt, h float64) []Reading {
	var rs []Reading
	for i := 0; i < days*24; i++ {
		rs = append(rs, Reading{TS: at(start + time.Duration(i)*time.Hour), Debt: debt, HFWorst: hf(h)})
	}
	return append(rs, Reading{TS: at(start + time.Duration(days)*day)})
}

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestACycleOpensWithDebtAndClosesWithoutIt(t *testing.T) {
	rs := append([]Reading{{TS: at(-time.Hour)}}, loan(0, 10, 100, 2.0)...)
	rs = append(rs, loan(20*day, 5, 50, 2.0)...)
	cs := BuildCycles(rs, nil, nil, nil)
	if len(cs) != 2 {
		t.Fatalf("want two cycles, got %d: %+v", len(cs), cs)
	}
	c := cs[0]
	if !c.OpenedAt.Equal(at(0)) || c.ClosedAt == nil || !c.ClosedAt.Equal(at(10*day)) {
		t.Errorf("first cycle runs %v → %v", c.OpenedAt, c.ClosedAt)
	}
	near(t, "usdg-days", c.USDGDays, 1000, 1e-6) // 100 USDG for 10 days
	near(t, "peak", c.PeakDebt, 100, 0)
	near(t, "debt seconds", c.DebtSeconds, 10*86400, 1e-6)
	if c.ClosedHow != "repaid" {
		t.Errorf("closed how = %q", c.ClosedHow)
	}
	near(t, "second cycle usdg-days", cs[1].USDGDays, 250, 1e-6)
}

func TestAnOpenCycleHasNoCloseAndNoInterest(t *testing.T) {
	rs := loan(0, 3, 100, 2.0)
	rs = rs[:len(rs)-1] // never repaid
	cs := BuildCycles(rs, []Flow{{TS: at(-time.Minute), Borrow: true, Amount: 100}}, nil, nil)
	if len(cs) != 1 || cs[0].ClosedAt != nil || cs[0].ClosedHow != "" || cs[0].Interest != nil {
		t.Fatalf("want one open cycle, got %+v", cs)
	}
	near(t, "borrowed", cs[0].Borrowed, 100, 0)
}

// The debt between two readings is the earlier reading's. A reader that stopped
// for a day leaves a day of debt on the record.
func TestAGapInTheReadingsStillCountsTheDebt(t *testing.T) {
	rs := []Reading{
		{TS: at(0), Debt: 200, HFWorst: hf(2)},
		{TS: at(2 * day), Debt: 200, HFWorst: hf(2)},
		{TS: at(3 * day)},
	}
	cs := BuildCycles(rs, nil, nil, nil)
	near(t, "usdg-days", cs[0].USDGDays, 600, 1e-6)
}

func TestEventsGoToTheCycleTheyHappenedIn(t *testing.T) {
	rs := append(loan(0, 10, 100, 2.0), loan(20*day, 5, 50, 2.0)...)
	flows := []Flow{
		{TS: at(-time.Minute), Borrow: true, Amount: 100},        // mined before the first reading saw it
		{TS: at(10*day - time.Minute), Amount: 101},              // the closing repay, with interest
		{TS: at(20*day - time.Minute), Borrow: true, Amount: 50}, // after the first close: the second loan
		{TS: at(25*day - time.Minute), Amount: 50.5},
		{TS: at(40 * day), Borrow: true, Amount: 7}, // after every close: no cycle yet
	}
	cs := BuildCycles(rs, flows, []time.Time{at(22 * day)}, []time.Time{at(23 * day)})
	near(t, "first borrowed", cs[0].Borrowed, 100, 0)
	near(t, "first repaid", cs[0].Repaid, 101, 0)
	near(t, "first interest", *cs[0].Interest, 1, 1e-9)
	near(t, "second borrowed", cs[1].Borrowed, 50, 0)
	if cs[0].DeleverageSteps != 0 || cs[1].DeleverageSteps != 1 || cs[1].Liquidations != 1 {
		t.Errorf("events landed in the wrong cycle: %+v", cs)
	}
	// A liquidation outranks a deleverage as the way a cycle closed.
	if cs[0].ClosedHow != "repaid" || cs[1].ClosedHow != "liquidated" {
		t.Errorf("closed how = %q, %q", cs[0].ClosedHow, cs[1].ClosedHow)
	}
}

func TestTimeUnderTheFloorIsMeasured(t *testing.T) {
	rs := []Reading{
		{TS: at(0), Debt: 100, HFWorst: hf(2.0)},
		{TS: at(3 * day), Debt: 100, HFWorst: hf(1.2)},
		{TS: at(4 * day), Debt: 100, HFWorst: hf(2.0)},
		{TS: at(10 * day)},
	}
	c := BuildCycles(rs, nil, nil, nil)[0]
	near(t, "seconds under floor", c.SecondsUnderFloor, 86400, 1e-6)
	near(t, "lowest", *c.LowestHFWorst, 1.2, 0)
}

// --- Score ---

func TestNeverBorrowedIsUnrated(t *testing.T) {
	r := Score(nil, at(0))
	if r.Rated || r.UnratedWhy == "" {
		t.Fatalf("want unrated with a reason, got %+v", r)
	}
}

func TestUnderThirtyDaysIsUnratedHoweverCleanly(t *testing.T) {
	cs := BuildCycles(loan(0, 20, 250, 3.0), nil, nil, nil)
	if r := Score(cs, at(29*day)); r.Rated {
		t.Fatalf("29 days of history was rated: %+v", r)
	}
	if r := Score(cs, at(31*day)); !r.Rated {
		t.Fatalf("31 days of history with a qualifying cycle was not rated: %s", r.UnratedWhy)
	}
}

// architecture.md §18.7 acceptance 7: many small cycles do not move the score.
// Each of these is under 10 USDG or under 24 hours, so none is evidence.
func TestManySmallCyclesAreNotEvidence(t *testing.T) {
	var rs []Reading
	for i := 0; i < 60; i++ {
		start := time.Duration(i) * day
		// 5 USDG for a full day: long enough, too small.
		rs = append(rs, Reading{TS: at(start), Debt: 5, HFWorst: hf(3)}, Reading{TS: at(start + 23*time.Hour + 59*time.Minute), Debt: 5, HFWorst: hf(3)}, Reading{TS: at(start + 23*time.Hour + 59*time.Minute + time.Second)})
	}
	for i := 0; i < 60; i++ {
		start := 70*day + time.Duration(i)*time.Hour
		// 200 USDG for a minute: large enough, far too short.
		rs = append(rs, Reading{TS: at(start), Debt: 200, HFWorst: hf(3)}, Reading{TS: at(start + time.Minute)})
	}
	cs := BuildCycles(rs, nil, nil, nil)
	if len(cs) != 120 {
		t.Fatalf("want 120 cycles, got %d", len(cs))
	}
	r := Score(cs, at(100*day))
	if r.Rated {
		t.Fatalf("120 cycles that are each too small or too short were rated %d: %+v", r.Score, r.Inputs)
	}
	if r.Inputs.QualifyingCycles != 0 {
		t.Errorf("qualifying = %d", r.Inputs.QualifyingCycles)
	}
}

// And beside one real loan, they add nothing to it.
func TestSmallCyclesAddNothingToARealRecord(t *testing.T) {
	realLoan := loan(0, 40, 250, 3.0)
	alone := Score(BuildCycles(realLoan, nil, nil, nil), at(100*day))
	rs := append([]Reading(nil), realLoan...)
	for i := 0; i < 200; i++ {
		start := 50*day + time.Duration(i)*time.Hour
		rs = append(rs, Reading{TS: at(start), Debt: 9, HFWorst: hf(3)}, Reading{TS: at(start + 30*time.Minute)})
	}
	padded := Score(BuildCycles(rs, nil, nil, nil), at(100*day))
	if padded.Score > alone.Score {
		t.Fatalf("200 small cycles raised the score from %d to %d", alone.Score, padded.Score)
	}
}

func TestACleanRecordScoresByHowMuchWasAtStake(t *testing.T) {
	small := Score(BuildCycles(loan(0, 30, 100, 3.0), nil, nil, nil), at(40*day))
	large := Score(BuildCycles(loan(0, 100, 250, 3.0), nil, nil, nil), at(110*day))
	if !small.Rated || !large.Rated {
		t.Fatal("both should be rated")
	}
	// 3,000 USDG-days: ln(31)/ln(251) = 0.6215 of the evidence.
	near(t, "small evidence", small.Inputs.EvidenceFraction, math.Log(31)/math.Log(251), 1e-9)
	near(t, "large evidence", large.Inputs.EvidenceFraction, 1, 1e-9)
	if small.Score >= large.Score {
		t.Fatalf("a small clean loan (%d) scored as well as a large one (%d)", small.Score, large.Score)
	}
	// Full evidence, full margin, no deleverage, one of twelve cycles closed.
	if want := int(math.Round(35 + 30 + 20 + 15.0/12)); large.Score != want {
		t.Errorf("large score = %d, want %d", large.Score, want)
	}
}

func TestTimeNearLiquidationCostsMargin(t *testing.T) {
	safe := loan(0, 100, 250, 3.0)
	risky := loan(0, 100, 250, 3.0)
	for i := 240; i < 480; i++ { // ten of the hundred days at 1.25
		risky[i].HFWorst = hf(1.25)
	}
	a := Score(BuildCycles(safe, nil, nil, nil), at(110*day))
	b := Score(BuildCycles(risky, nil, nil, nil), at(110*day))
	near(t, "share under floor", b.Inputs.ShareUnderFloor, 0.1, 1e-6)
	// 90% of the time above the floor, and a low half way to liquidation.
	near(t, "margin quality", b.Inputs.MarginQuality, 0.9*0.5, 1e-6)
	if b.Components.Margin >= a.Components.Margin {
		t.Fatalf("margin did not fall: %v vs %v", b.Components.Margin, a.Components.Margin)
	}
}

func TestDeleverageStepsCostSelfSufficiency(t *testing.T) {
	rs := loan(0, 60, 250, 3.0)
	clean := Score(BuildCycles(rs, nil, nil, nil), at(70*day))
	// Four steps in sixty debt-days is two per thirty: half marks.
	steps := []time.Time{at(5 * day), at(6 * day), at(7 * day), at(8 * day)}
	helped := Score(BuildCycles(rs, nil, steps, nil), at(70*day))
	near(t, "rate", helped.Inputs.DeleverageRate30d, 2, 1e-6)
	near(t, "quality", helped.Inputs.SelfSufficiencyQ, 0.5, 1e-6)
	if helped.Score >= clean.Score {
		t.Fatalf("being deleveraged did not cost anything: %d vs %d", helped.Score, clean.Score)
	}
	// And the cycle the guard had to act in is not one the agent closed.
	if helped.Inputs.CyclesRepaid != 0 || clean.Inputs.CyclesRepaid != 1 {
		t.Errorf("cycles repaid: %d and %d", helped.Inputs.CyclesRepaid, clean.Inputs.CyclesRepaid)
	}
}

// --- TierFor ---

var tiers = []Tier{
	{Tier: 0, MinScore: 0, MaxDebtUSDG: 250},
	{Tier: 1, MinScore: 40, MaxDebtUSDG: 1000},
	{Tier: 2, MinScore: 60, MaxDebtUSDG: 2500, MinScoredDays: 90},
	{Tier: 3, MinScore: 80, MaxDebtUSDG: 5000, MinScoredDays: 90},
}

func rated(score int) Result { return Result{Rated: true, Score: score} }

func TestTheScoreChoosesTheTier(t *testing.T) {
	for _, c := range []struct{ score, want int }{{0, 0}, {39, 0}, {40, 1}, {59, 1}, {60, 2}, {79, 2}, {80, 3}, {100, 3}} {
		s := TierFor(rated(c.score), tiers, 365, nil, nil, at(0))
		if s.Tier != c.want || s.EarnedTier != c.want || s.HeldBecause != "" {
			t.Errorf("score %d: %+v, want tier %d", c.score, s, c.want)
		}
	}
}

func TestUnratedIsTierZero(t *testing.T) {
	if s := TierFor(Result{Score: 99}, tiers, 365, nil, nil, at(0)); s.Tier != 0 || s.EarnedTier != 0 {
		t.Fatalf("an unrated agent holds %+v", s)
	}
}

func TestAHighTierNeedsAScoredTrackRecord(t *testing.T) {
	s := TierFor(rated(85), tiers, 30, nil, nil, at(0))
	if s.EarnedTier != 3 || s.Tier != 1 || s.HeldBecause != "performance_gate" {
		t.Fatalf("85 with 30 scored days: %+v, want earned 3, held at 1", s)
	}
	if s := TierFor(rated(85), tiers, 90, nil, nil, at(0)); s.Tier != 3 || s.HeldBecause != "" {
		t.Fatalf("85 with 90 scored days: %+v", s)
	}
}

func TestALiquidationIsNotAveragedAway(t *testing.T) {
	liq := []time.Time{at(0)}
	if s := TierFor(rated(95), tiers, 365, liq, nil, at(89*day)); s.Tier != 0 || s.EarnedTier != 3 || s.HeldBecause != "liquidation" {
		t.Fatalf("89 days after a liquidation: %+v", s)
	}
	if s := TierFor(rated(95), tiers, 365, liq, nil, at(91*day)); s.Tier != 3 {
		t.Fatalf("91 days after a liquidation: %+v", s)
	}
}

func TestAStuckDeleverageHoldsTheTierForAMonth(t *testing.T) {
	stuck := []time.Time{at(0)}
	if s := TierFor(rated(70), tiers, 365, nil, stuck, at(29*day)); s.Tier != 0 || s.HeldBecause != "deleverage_stuck" {
		t.Fatalf("29 days after: %+v", s)
	}
	if s := TierFor(rated(70), tiers, 365, nil, stuck, at(31*day)); s.Tier != 2 {
		t.Fatalf("31 days after: %+v", s)
	}
}

// --- Limit ---

func TestDisabledCreditIsThePlatformCapForEveryone(t *testing.T) {
	now := at(0)
	for tier := 0; tier <= 3; tier++ {
		if got := Limit(false, tiers, 250, tier, &now, now); got != 250 {
			t.Errorf("tier %d with credit disabled = %v, want 250", tier, got)
		}
	}
}

func TestTheLimitIsTheTiersAndNeverAboveTheCeiling(t *testing.T) {
	now := at(0)
	for tier, want := range []float64{250, 1000, 2500, 5000} {
		if got := Limit(true, tiers, 5000, tier, &now, now); got != want {
			t.Errorf("tier %d = %v, want %v", tier, got, want)
		}
	}
	if got := Limit(true, tiers, 2000, 3, &now, now); got != 2000 {
		t.Errorf("tier 3 under a ceiling of 2000 = %v", got)
	}
}

func TestAMissingOrStaleReputationIsTierZero(t *testing.T) {
	now := at(0)
	if got := Limit(true, tiers, 5000, 3, nil, now); got != 250 {
		t.Errorf("no reputation row = %v, want 250", got)
	}
	old := now.Add(-49 * time.Hour)
	if got := Limit(true, tiers, 5000, 3, &old, now); got != 250 {
		t.Errorf("a 49-hour-old reputation = %v, want 250", got)
	}
	fresh := now.Add(-47 * time.Hour)
	if got := Limit(true, tiers, 5000, 3, &fresh, now); got != 5000 {
		t.Errorf("a 47-hour-old reputation = %v, want 5000", got)
	}
}
