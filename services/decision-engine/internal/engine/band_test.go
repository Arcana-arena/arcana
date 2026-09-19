package engine

import (
	"math"
	"testing"
	"time"

	"github.com/arcana/decision-engine/internal/marketdata"
)

// The band has to mean the same thing at every cadence, and the arithmetic that
// makes that true is the whole feature. These numbers are the ones an owner sees.
func TestBandScalesWithTheSquareRootOfTheWindow(t *testing.T) {
	const configured = 0.003 // 0.3% over four hours, the owner's number

	cases := []struct {
		cadence time.Duration
		want    float64
	}{
		{4 * time.Hour, 0.003},         // the reference itself, unchanged
		{time.Hour, 0.0015},            // sqrt(1/4)  = 1/2
		{15 * time.Minute, 0.00075},    // sqrt(1/16) = 1/4
		{time.Minute, 0.003 * 0.06455}, // sqrt(60/14400)
		{24 * time.Hour, 0.003 * 2.449},
	}
	for _, c := range cases {
		got := bandForCadence(configured, c.cadence)
		if math.Abs(got-c.want) > c.want*0.001 {
			t.Errorf("cadence %s: band %.6f, want %.6f", c.cadence, got, c.want)
		}
	}

	// LINEAR SCALING WOULD BE THE OBVIOUS MISTAKE, and it is wrong in the
	// direction that costs money: at one minute it gives 1/240th of the band —
	// about an eighth of the cheapest pool fee — so every minute's noise reads as
	// a signal. This is the assertion that stops somebody "simplifying" the
	// square root away.
	linear := configured * (60.0 / 14400.0)
	if got := bandForCadence(configured, time.Minute); got <= linear*2 {
		t.Errorf("one-minute band %.8f is not clearly above the linear answer %.8f; "+
			"the square-root scaling has been lost", got, linear)
	}
}

func TestBandIsUnchangedWhenThereIsNothingToScaleBy(t *testing.T) {
	if got := bandForCadence(0.003, 0); got != 0.003 {
		t.Errorf("a cadence of zero must leave the band alone, got %.6f", got)
	}
	if got := bandForCadence(0.003, -time.Minute); got != 0.003 {
		t.Errorf("a negative cadence must leave the band alone, got %.6f", got)
	}
	if got := bandForCadence(0, time.Minute); got != 0 {
		t.Errorf("a band of zero stays zero — an owner asking to act on any move at all, got %.6f", got)
	}
}

// The floor is the venue's, and it is the reason a one-minute agent does not
// trade on noise: 1.9 bp scaled against a 5 bp fee is a ticket that cannot pay
// for itself.
func TestTheFeeIsTheFloorUnderTheBand(t *testing.T) {
	scaled := bandForCadence(0.003, time.Minute) // ~0.000194
	tight := oneWayPct(500)                      // 5 bp
	wide := oneWayPct(3000)                      // 30 bp

	if got := effectiveBand(scaled, tight); got != tight {
		t.Errorf("a 5 bp pool must floor a %.6f band at %.6f, got %.6f", scaled, tight, got)
	}
	if got := effectiveBand(scaled, wide); got != wide {
		t.Errorf("a 30 bp pool must floor it at %.6f, got %.6f", wide, got)
	}

	// AND THE FLOOR DOES NOT BECOME A CEILING. A four-hour agent whose band is
	// above every fee keeps its own number; the floor only ever raises.
	if got := effectiveBand(0.003, tight); got != 0.003 {
		t.Errorf("a band above the fee must be left alone, got %.6f", got)
	}

	// NO POOL, NO FLOOR. The paper path has no fee, and an unknown fee must not
	// arrive as zero and silently become the threshold.
	if got := effectiveBand(scaled, 0); got != scaled {
		t.Errorf("an absent fee must not floor anything, got %.6f want %.6f", got, scaled)
	}
}

// materialMove is the gate that decides whether inference is bought at all, and
// it has to ask per symbol: the nine pools do not charge the same fee.
func TestMaterialMoveAsksPerSymbolAgainstTheFee(t *testing.T) {
	view := marketView{
		symbols: []marketdata.Quote{{Symbol: "AAPL", Price: 100}, {Symbol: "TSLA", Price: 100}},
		prices:  map[string]float64{"AAPL": 100.2, "TSLA": 100.2},
		prev:    map[string]float64{"AAPL": 100, "TSLA": 100},
	}
	l := RiskLimits{RebalanceBandPct: 0.0001} // scaled tiny, as a fast cadence gives
	fee := map[string]float64{
		"AAPL": oneWayPct(500),  // 5 bp  -> a 0.2% move clears it
		"TSLA": oneWayPct(3000), // 30 bp -> 0.2% does not
	}

	if !materialMove(view, l, fee) {
		t.Error("a 0.2% move on a 5 bp pool is material and must reach the model")
	}

	// Only the expensive pool left: the same move is no longer worth acting on.
	only := marketView{
		symbols: []marketdata.Quote{{Symbol: "TSLA", Price: 100}},
		prices:  map[string]float64{"TSLA": 100.2},
		prev:    map[string]float64{"TSLA": 100},
	}
	if materialMove(only, l, map[string]float64{"TSLA": oneWayPct(30000)}) {
		t.Error("a move smaller than the pool's own fee must not buy inference")
	}
}
