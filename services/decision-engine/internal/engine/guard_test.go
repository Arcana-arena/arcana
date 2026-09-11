package engine

import (
	"strings"
	"testing"
	"time"

	"github.com/arcana/decision-engine/internal/store"
)

// The arithmetic and the refusals behind a protective level.
//
// These are the parts a verification against a live chain cannot reach cheaply:
// every malformed level a prompt could ask for, and the exact boundary of each
// refusal. The chain-side proof — that a crossing produces a real transaction —
// is in guard-verify, and neither substitutes for the other.

// Every case names the pool it is in, because the near bound comes from that
// pool rather than from a constant. tightPool is the 5 bp tier (AAPL, NVDA,
// GOOGL, SPY, QQQ) and widePool the 30 bp tier (TSLA, AMZN, MSFT, META).
const (
	tightPool uint32 = 500  // 0.05% each way, 0.1% round trip
	widePool  uint32 = 3000 // 0.30% each way, 0.6% round trip
)

func lv(t *testing.T, sl, tp, entry float64, fee uint32) armedLevels {
	t.Helper()
	return resolveGuardLevels(guardLevels{StopLossPct: sl, TakeProfitPct: tp}, entry, fee)
}

// near, because a level is arithmetic on a float64 and 200*1.10 is
// 220.00000000000003. The production code has no reason to care — a level is
// compared against a price, not against another level — but a test that
// demanded exactness would fail on the representation rather than on the
// behaviour, which is the kind of red light that gets a suite ignored.
func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func TestLevelsAreMeasuredFromThePricePaid(t *testing.T) {
	a := lv(t, 0.05, 0.10, 200, tightPool)
	if a.StopLoss == nil || !near(*a.StopLoss, 190) {
		t.Fatalf("stop: want 190, got %v", deref(a.StopLoss))
	}
	if a.TakeProfit == nil || !near(*a.TakeProfit, 220) {
		t.Fatalf("target: want 220, got %v", deref(a.TakeProfit))
	}
	// The percentages are kept, so a level can be explained rather than only
	// restated.
	if a.SLPct == nil || *a.SLPct != 0.05 || a.TPPct == nil || *a.TPPct != 0.10 {
		t.Fatalf("percentages not carried: %v %v", a.SLPct, a.TPPct)
	}
}

func TestALevelInsideTheRoundTripIsRefused(t *testing.T) {
	// 0.5% on a pool that charges 0.3% each way. The round trip is 0.6%, so this
	// position is already 0.6% underwater the instant it opens and the level
	// would fire on its own entry.
	a := lv(t, 0.005, 0, 200, widePool)
	if a.any() {
		t.Fatalf("a level inside the fee was armed: %v", a.StopLoss)
	}
	if len(a.Refusals) != 1 || !strings.Contains(a.Refusals[0], "its own entry") {
		t.Fatalf("the refusal does not say why: %v", a.Refusals)
	}
}

func TestTheBoundaryItselfIsRefusedAndJustPastItIsNot(t *testing.T) {
	// AT the round trip the level is crossed at the moment of entry, because the
	// comparison is inclusive. So the boundary is refused and the first level
	// above it is armed -- the opposite of the usual convention, and it is the
	// arithmetic that decides which way round it goes, not the convention.
	for _, tc := range []struct {
		name string
		fee  uint32
	}{{"tight", tightPool}, {"wide", widePool}} {
		rt := roundTripPct(tc.fee)
		if a := lv(t, rt, 0, 100, tc.fee); a.StopLoss != nil {
			t.Fatalf("%s: a stop exactly at the %.3f%% round trip was armed; it fires at open",
				tc.name, rt*100)
		}
		if a := lv(t, rt*1.01, 0, 100, tc.fee); a.StopLoss == nil {
			t.Fatalf("%s: a stop just outside the %.3f%% round trip was refused: %v",
				tc.name, rt*100, lv(t, rt*1.01, 0, 100, tc.fee).Refusals)
		}
	}
}

func TestTheBoundIsThePoolsOwnRoundTrip(t *testing.T) {
	// THE BUG THIS CLOSES. The first version used one flat 0.4% for every pool,
	// reasoning from ONE side of the round trip on the widest one. A 0.5% stop
	// on a 30 bp pool passed that check and would have fired on its own entry.
	if a := lv(t, 0.005, 0, 100, tightPool); a.StopLoss == nil {
		t.Fatal("0.5% is a real level on a 5 bp pool (0.1% round trip) and was refused")
	}
	if a := lv(t, 0.005, 0, 100, widePool); a.StopLoss != nil {
		t.Fatal("0.5% on a 30 bp pool (0.6% round trip) fires at open and was armed")
	}
}

func TestAnUnreachableStopIsRefused(t *testing.T) {
	a := lv(t, 0.99, 0, 100, tightPool)
	if a.any() {
		t.Fatal("a stop 99% below entry was armed; it can never be crossed")
	}
	if len(a.Refusals) != 1 || !strings.Contains(a.Refusals[0], "cannot be crossed") {
		t.Fatalf("the refusal does not say why: %v", a.Refusals)
	}
}

func TestARefusedLevelDoesNotTakeTheOtherOneWithIt(t *testing.T) {
	// A malformed stop must not silently remove a valid target, and the record
	// has to say that one of the two was refused.
	a := lv(t, 0.0001, 0.10, 100, tightPool)
	if a.TakeProfit == nil {
		t.Fatal("a valid take profit was dropped because the stop was malformed")
	}
	if a.StopLoss != nil {
		t.Fatal("the malformed stop was armed anyway")
	}
	if len(a.Refusals) != 1 {
		t.Fatalf("want exactly one refusal, got %v", a.Refusals)
	}
	if !strings.Contains(guardSummary(a, 100), "refused") {
		t.Fatalf("the rationale does not mention the refusal: %q", guardSummary(a, 100))
	}
}

func TestNothingIsArmedWithoutAMeasuredEntryPrice(t *testing.T) {
	// filledPrice returns 0 when the fill could not be measured. Arming a level
	// against that would put a stop at zero, which is a guard that watches
	// forever and never fires.
	a := lv(t, 0.05, 0.10, 0, tightPool)
	if a.any() {
		t.Fatal("levels were armed against an unmeasurable entry price")
	}
	if len(a.Refusals) != 1 || !strings.Contains(a.Refusals[0], "entry price") {
		t.Fatalf("the refusal does not say why: %v", a.Refusals)
	}
}

func TestAskingForNothingArmsNothingAndComplainsAboutNothing(t *testing.T) {
	a := lv(t, 0, 0, 200, tightPool)
	if a.any() || len(a.Refusals) != 0 {
		t.Fatalf("an agent that set no levels got %v / %v", a.StopLoss, a.Refusals)
	}
	if guardSummary(a, 200) != "" {
		t.Fatalf("a rationale was decorated with nothing: %q", guardSummary(a, 200))
	}
}

// --- crossing ------------------------------------------------------------

func levels(sl, tp *float64) struct{ TakeProfit, StopLoss *float64 } {
	return struct{ TakeProfit, StopLoss *float64 }{TakeProfit: tp, StopLoss: sl}
}

func f(v float64) *float64 { return &v }

func TestCrossingIsInclusive(t *testing.T) {
	// A level is a price somebody named. A price that equals it has reached it,
	// and a strict comparison would make an exactly-hit level do nothing —
	// which is impossible to explain to whoever set it.
	if got := crossed(levels(f(190), f(220)), 190); got != "stop_loss" {
		t.Fatalf("exactly at the stop: want stop_loss, got %q", got)
	}
	if got := crossed(levels(f(190), f(220)), 220); got != "take_profit" {
		t.Fatalf("exactly at the target: want take_profit, got %q", got)
	}
}

func TestInsideTheLevelsIsNotACrossing(t *testing.T) {
	if got := crossed(levels(f(190), f(220)), 200); got != "" {
		t.Fatalf("a price between the levels fired %q", got)
	}
	if got := crossed(levels(f(190), f(220)), 190.0001); got != "" {
		t.Fatalf("a price just inside the stop fired %q", got)
	}
}

func TestOnlyOneSideNeedExist(t *testing.T) {
	if got := crossed(levels(f(190), nil), 180); got != "stop_loss" {
		t.Fatalf("a stop-only guard did not fire: %q", got)
	}
	if got := crossed(levels(f(190), nil), 9999); got != "" {
		t.Fatalf("a stop-only guard fired on a rise: %q", got)
	}
	if got := crossed(levels(nil, f(220)), 230); got != "take_profit" {
		t.Fatalf("a target-only guard did not fire: %q", got)
	}
	if got := crossed(levels(nil, f(220)), 1); got != "" {
		t.Fatalf("a target-only guard fired on a fall: %q", got)
	}
}

func TestProtectingCapitalWinsATie(t *testing.T) {
	// The schema forbids stop >= target, so this should be unreachable. If a
	// future edit reintroduces it, the stop is the one to act on rather than
	// whichever branch happens to be written first.
	if got := crossed(levels(f(200), f(200)), 200); got != "stop_loss" {
		t.Fatalf("want stop_loss on a tie, got %q", got)
	}
}

// --- who decided ---------------------------------------------------------

func TestProtectiveReasonCodesAreDistinct(t *testing.T) {
	if reasonFor("stop_loss") != ReasonStopLoss || reasonFor("take_profit") != ReasonTakeProfit {
		t.Fatal("the two sides must be distinguishable in the record")
	}
	if ReasonStopLoss == ReasonTakeProfit {
		t.Fatal("an agent saved by a stop and an agent taking a profit are different events")
	}
	if DeciderProtective == "llm" || DeciderProtective == "deterministic" || DeciderProtective == "human" {
		t.Fatalf("the protective author must be distinguishable from every other: %q", DeciderProtective)
	}
}

func TestTheRationaleSaysNoOneDecidedAndNamesThePriceSource(t *testing.T) {
	g := guardForTest()
	r := protectiveRationale(g, Trigger{Side: "stop_loss", Price: 189.5}, "pool-20260911T1100Z")
	for _, want := range []string{
		"stop loss",           // which side
		"189.5",               // the price that fired it
		"190",                 // the level
		"Decided by no one",   // the author, stated
		"was NOT the input",   // the snapshot ref is carried, not claimed as input
	} {
		if !strings.Contains(r, want) {
			t.Fatalf("the rationale is missing %q:\n%s", want, r)
		}
	}
}

func guardForTest() store.Guard {
	return store.Guard{
		ID: 1, AgentID: "a", Symbol: "GOOGL",
		EntryPrice: 200, EntryQty: 1,
		StopLoss: f(190), TakeProfit: f(220),
		SetAt: time.Date(2026, 9, 11, 2, 36, 0, 0, time.UTC),
	}
}

func deref(p *float64) any {
	if p == nil {
		return "nil"
	}
	return *p
}
