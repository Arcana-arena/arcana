package engine

import (
	"math/big"
	"testing"

	"github.com/arcana/decision-engine/internal/marketdata"
)

// The residue, reproduced with the number that actually produced it.
//
// WHY THESE TESTS EXIST AT ALL. The fix can be read off the branches: the exit
// returns the balance, toAnyMap drops small entries, HasPosition compares
// against a floor. Reading them proves the code says what it says. The bug was
// never in what the code said — every step was individually reasonable, and the
// loss happened inside a conversion nobody was looking at.
//
// So these drive the conversion. The balance below is the real fill from
// transaction 0x9288a397…, seventeen significant digits, and the float64 the
// first test derives from it is the one that was actually stored in the
// snapshot. If the round trip ever becomes lossless, the first test fails and
// says so rather than passing quietly on a bug it is no longer reproducing.

// The exact fill of the GOOGL buy on 2026-09-11, in base units.
const realFillUnits = "17704874344043495"

func TestFloatRoundTripIsWhatLeftTheResidue(t *testing.T) {
	have, _ := new(big.Int).SetString(realFillUnits, 10)

	// What the snapshot stored: the balance, through a float64.
	asFloat := unitsToShares(have, 18)
	// What a sell built from that stored figure asks the chain for.
	naive := toUnits(asFloat, 18)

	if naive.Cmp(have) == 0 {
		t.Fatalf("the round trip is lossless for %s, so this test is no longer reproducing "+
			"the bug it was written for", have)
	}
	residue := new(big.Int).Sub(have, naive)
	if residue.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("expected exactly one wei left behind, got %s", residue)
	}
	t.Logf("balance %s -> float64 -> %s, leaving %s wei behind", have, naive, residue)
}

func TestExitSendsTheBalanceRatherThanTheFloat(t *testing.T) {
	have, _ := new(big.Int).SetString(realFillUnits, 10)

	// The intent as a decider produces it: the whole position, as a float.
	got := exitAmount(have, unitsToShares(have, 18), 18)
	if got == nil {
		t.Fatal("an exit was not recognised as one, so the sell would go through the float")
	}
	if got.Cmp(have) != 0 {
		t.Fatalf("exit amount %s is not the balance %s", got, have)
	}
	if new(big.Int).Sub(have, got).Sign() != 0 {
		t.Fatalf("the exit would leave %s behind", new(big.Int).Sub(have, got))
	}
}

func TestExitAlsoCoversAskingForMoreThanIsThere(t *testing.T) {
	have := big.NewInt(1000)
	got := exitAmount(have, 1.0, 18) // 1.0 shares = 1e18 units, far more than 1000
	if got == nil || got.Cmp(have) != 0 {
		t.Fatalf("want the balance %s, got %v", have, got)
	}
}

func TestPartialSellIsLeftAlone(t *testing.T) {
	// A tenth of a share out of a full share: the remainder is a real position
	// and must not be swept into the sell.
	have := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	if got := exitAmount(have, 0.1, 18); got != nil {
		t.Fatalf("a partial sell was treated as an exit: %s", got)
	}
}

func TestRemainderBelowTheFloorIsSweptNotLeft(t *testing.T) {
	dust := dustUnits(18) // 1e-8 shares, in wei
	want := new(big.Int).Mul(dust, big.NewInt(1000))
	have := new(big.Int).Add(want, big.NewInt(1)) // one wei more than will be asked for

	got := exitAmount(have, unitsToShares(want, 18), 18)
	if got == nil || got.Cmp(have) != 0 {
		t.Fatalf("a one-wei remainder was left behind rather than swept: got %v, balance %s", got, have)
	}
}

func TestAnExitLeavesNothingAtEveryScale(t *testing.T) {
	// The property, rather than one example: for any balance, selling the
	// float64 of that balance must empty it.
	for _, s := range []string{
		"1", "999", "17704874344043495", "15850403013324053",
		"1000000000000000000", "123456789012345678901",
	} {
		have, _ := new(big.Int).SetString(s, 10)
		got := exitAmount(have, unitsToShares(have, 18), 18)
		if got == nil {
			t.Fatalf("balance %s: selling all of it was not treated as an exit", s)
		}
		if new(big.Int).Sub(have, got).Sign() != 0 {
			t.Fatalf("balance %s: %s left behind", s, new(big.Int).Sub(have, got))
		}
	}
}

// --- the readers ---------------------------------------------------------

func TestResidueIsNotAPosition(t *testing.T) {
	h := map[string]any{"GOOGL": 1e-18}
	if HasPosition(h, "GOOGL") {
		t.Fatal("a wei of residue is being read as a position")
	}
	if q := HeldQty(h, "GOOGL"); q != 0 {
		t.Fatalf("HeldQty on a residue: want 0, got %v", q)
	}
	if n := PositionCount(h); n != 0 {
		t.Fatalf("PositionCount over residue only: want 0, got %d", n)
	}
}

func TestTheSmallestRecordableQuantityIsAPosition(t *testing.T) {
	// The floor itself is INSIDE, not outside. A quantity that can be written
	// down is a position by the definition's own argument.
	h := map[string]any{"GOOGL": DustFloor}
	if !HasPosition(h, "GOOGL") {
		t.Fatalf("%.0e is recordable in numeric(20,8) and must count as a position", DustFloor)
	}
	if PositionCount(h) != 1 {
		t.Fatal("the floor itself should count")
	}
}

func TestSnapshotsAreWrittenWithoutResidue(t *testing.T) {
	out := toAnyMap(map[string]float64{"GOOGL": 1e-18, "AAPL": 0.5})
	if _, ok := out["GOOGL"]; ok {
		t.Fatal("a residue was written into a snapshot")
	}
	if out["AAPL"] != 0.5 {
		t.Fatalf("a real position was dropped: %v", out)
	}
}

func TestPruneDustKeepsTheFloor(t *testing.T) {
	out := pruneDust(map[string]any{"A": DustFloor, "B": DustFloor / 2})
	if _, ok := out["A"]; !ok {
		t.Fatal("the floor itself was pruned")
	}
	if _, ok := out["B"]; ok {
		t.Fatal("a below-floor entry survived")
	}
}

func TestBuyAndHoldRebuysAfterAnExitLeavesResidue(t *testing.T) {
	// The reader case with teeth. buy-and-hold skips any symbol it "already
	// owns"; with a residue it would skip GOOGL forever and never rebuild the
	// position, which reads exactly like a strategy that decided to stop.
	l := limitsFor(0.20, 1.0, 0.0, 0.01)
	view := marketView{
		symbols: []marketdata.Quote{{Symbol: "GOOGL", Price: 100}},
		prices:  map[string]float64{"GOOGL": 100},
	}
	got := buyAndHoldStrategy(view, map[string]any{"GOOGL": 1e-18}, 1000, 1000, l)
	if got.Action != "buy" || got.Symbol != "GOOGL" {
		t.Fatalf("buy-and-hold skipped a symbol it holds only residue of: %s %s (%s)",
			got.Action, got.Symbol, got.Rationale)
	}
}

func TestMomentumWillNotBuildASellOutOfResidue(t *testing.T) {
	// A falling symbol the agent holds only residue of must not become a sell.
	// The transaction would spend an approval and a swap to move one wei, and
	// the quantity could not be written into decisions.quantity at all.
	l := limitsFor(0.20, 1.0, 0.0, 0.01)
	view := marketView{
		symbols: []marketdata.Quote{{Symbol: "GOOGL", Price: 90}},
		prices:  map[string]float64{"GOOGL": 90},
		prev:    map[string]float64{"GOOGL": 100},
	}
	got := momentumStrategy(view, map[string]any{"GOOGL": 1e-18}, 0, 1000, l, nil)
	if got.Action == "sell" {
		t.Fatalf("momentum tried to sell residue: %+v", got)
	}
}

func TestMomentumStillSellsARealPosition(t *testing.T) {
	// The control. Without it the test above could pass because the strategy
	// stopped selling anything at all.
	l := limitsFor(0.20, 1.0, 0.0, 0.01)
	view := marketView{
		symbols: []marketdata.Quote{{Symbol: "GOOGL", Price: 90}},
		prices:  map[string]float64{"GOOGL": 90},
		prev:    map[string]float64{"GOOGL": 100},
	}
	got := momentumStrategy(view, map[string]any{"GOOGL": 0.5}, 0, 1000, l, nil)
	if got.Action != "sell" || got.Symbol != "GOOGL" {
		t.Fatalf("momentum stopped selling real positions too: %+v", got)
	}
}

func TestVirtualSellEmptiesRatherThanLeavingResidue(t *testing.T) {
	// The virtual path carries the same obligation as the chain path.
	in := tradeIntent{Action: "sell", Symbol: "GOOGL", Quantity: 0.5}
	_, _, _, out, _, _ := applyIntent(in, map[string]float64{"GOOGL": 100}, map[string]any{"GOOGL": 0.5}, 0)
	if _, ok := out["GOOGL"]; ok {
		t.Fatalf("a full virtual sell left the symbol in holdings: %v", out)
	}
}

func TestVirtualSellCannotBeBuiltFromResidue(t *testing.T) {
	in := tradeIntent{Action: "sell", Symbol: "GOOGL", Quantity: 1e-18}
	action, _, _, _, _, _ := applyIntent(in, map[string]float64{"GOOGL": 100}, map[string]any{"GOOGL": 1e-18}, 0)
	if action == "sell" {
		t.Fatal("a residue was sold on the virtual path")
	}
}
