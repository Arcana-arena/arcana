package store

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// THE ROUND TRIPS THAT ACTUALLY HAPPENED, onchain_live_v1 on 2026-09-14, in
// quote units spent and received. The ledger must reproduce the figures that
// were computed by hand from the executions table: +0.0053, +0.0066, -0.0312.
func TestRealTripsRealizeWhatWasComputedByHand(t *testing.T) {
	trips := []struct {
		shares       float64
		spent, got   float64
		wantRealized float64
	}{
		{0.01046039, 3.4592, 3.4645, 0.0053},
		{0.01102171, 3.6800, 3.6866, 0.0066},
		{0.00688212, 3.5007, 3.4695, -0.0312},
	}
	st := PositionState{}
	for i, tr := range trips {
		buy := ApplyFill(st, 0, "buy", tr.shares, tr.spent/tr.shares)
		if buy.After.Episode != i+1 || buy.After.AvgCost == nil {
			t.Fatalf("trip %d: buy opened episode %d with basis %v", i, buy.After.Episode, buy.After.AvgCost)
		}
		sell := ApplyFill(buy.After, tr.shares, "sell", tr.shares, tr.got/tr.shares)
		if sell.RealizedPnL == nil || !near(*sell.RealizedPnL, tr.wantRealized) {
			t.Fatalf("trip %d: realized %v, want %v", i, sell.RealizedPnL, tr.wantRealized)
		}
		if sell.After.Qty != 0 || sell.After.Episode != i+1 {
			t.Fatalf("trip %d: after the exit qty %v episode %d", i, sell.After.Qty, sell.After.Episode)
		}
		st = sell.After
	}
}

func TestTopUpAveragesAndPartialSellKeepsTheAverage(t *testing.T) {
	a := ApplyFill(PositionState{}, 0, "buy", 2, 100)
	b := ApplyFill(a.After, 2, "buy", 2, 110)
	if !near(*b.After.AvgCost, 105) || b.After.Episode != 1 {
		t.Fatalf("average %v episode %d", *b.After.AvgCost, b.After.Episode)
	}
	c := ApplyFill(b.After, 4, "sell", 1, 120)
	if !near(*c.RealizedPnL, 15) || !near(*c.After.AvgCost, 105) || !near(c.After.Qty, 3) {
		t.Fatalf("partial sell: realized %v avg %v qty %v", *c.RealizedPnL, *c.After.AvgCost, c.After.Qty)
	}
}

// SHARES NOBODY RECORDED BUYING have no cost, and the ledger says so rather
// than pricing them at today's fill.
func TestSharesWithoutAFillMakeTheBasisUnknown(t *testing.T) {
	out := ApplyFill(PositionState{}, 0.5, "buy", 0.5, 100)
	if out.After.AvgCost != nil {
		t.Fatalf("basis should be unknown, got %v", *out.After.AvgCost)
	}
	if out.Note == "" {
		t.Fatal("the unknown basis must be named in the note")
	}
	sell := ApplyFill(out.After, 1, "sell", 1, 110)
	if sell.RealizedPnL != nil {
		t.Fatalf("realized must be unknown, got %v", *sell.RealizedPnL)
	}
	// Flat again: the next position starts with a known basis.
	next := ApplyFill(sell.After, 0, "buy", 1, 90)
	if next.After.AvgCost == nil || next.After.Episode != sell.After.Episode+1 {
		t.Fatalf("a fresh position after flat should have a known basis and a new episode: %+v", next.After)
	}
}

func TestSharesMovedOutKeepTheirBasisAndRealizeNothing(t *testing.T) {
	a := ApplyFill(PositionState{}, 0, "buy", 4, 50)
	out := ApplyFill(a.After, 3, "sell", 3, 60)
	if out.Before.Qty != 3 || !near(*out.Before.AvgCost, 50) || !near(*out.RealizedPnL, 30) {
		t.Fatalf("moved-out reconciliation: %+v realized %v", out.Before, *out.RealizedPnL)
	}
	if out.Note == "" {
		t.Fatal("shares leaving outside ARCANA must be named")
	}
}
