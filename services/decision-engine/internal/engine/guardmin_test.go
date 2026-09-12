package engine

import (
	"strings"
	"testing"

	"github.com/arcana/decision-engine/internal/marketdata"
)

// The model is told what each pool will accept, symbol by symbol.
//
// WHY THIS FILE EXISTS. The prompt said "0.001 on the tight pools and 0.006 on
// the wide ones" and never said which symbol was which. A mandate asking for one
// number — "get out if it drops 0.15% below what you paid" — therefore produced
// 0.0015 for every symbol. The 5 bp pools take that; the 30 bp pools refuse it.
//
// The result was not theoretical. On the live agent, every buy of MSFT, META,
// AMZN or TSLA opened a position with NO protective level at all, while every
// buy of NVDA armed two:
//
//	decision 1899  buy MSFT  -> 0 guards        decision 1973  buy NVDA -> 2 guards
//	decision 1792  buy MSFT  -> 0 guards        decision 1967  buy NVDA -> 2 guards
//	decision 1790  buy META  -> 0 guards
//
// Four of the nine listed symbols, unguarded by arithmetic nobody had been told
// about. The refusal was recorded each time and nobody was reading it.
//
// THE PLATFORM STILL DOES NOT CHOOSE THE LEVEL. It states a fact about the venue
// — this pool will not accept less than this — and the model decides what to ask
// for. An unguarded position stays legal, and a level below the bound is still
// refused and still recorded. What changes is only that asking for one by
// accident now requires ignoring the number sitting beside the price.

func TestTheMarketTableStatesWhatEachPoolWillAccept(t *testing.T) {
	in := DeciderInput{
		View: marketView{
			symbols: []marketdata.Quote{{Symbol: "NVDA"}, {Symbol: "MSFT"}},
			prices:  map[string]float64{"NVDA": 219.0, "MSFT": 510.0},
		},
		// NVDA on a 5 bp pool, MSFT on a 30 bp one: the six-fold difference that
		// one number cannot straddle.
		MinGuardPct: map[string]float64{"NVDA": roundTripPct(500), "MSFT": roundTripPct(3000)},
	}
	p := buildPrompt(in)

	for _, want := range []string{"0.0010", "0.0060"} {
		if !strings.Contains(p, want) {
			t.Fatalf("the prompt does not carry %s, so the model cannot tell the pools apart:\n%s", want, p)
		}
	}

	// Each number must sit on ITS OWN symbol's line. Both appearing somewhere is
	// what the old prose already did, and it is what failed.
	for _, tc := range []struct{ sym, want string }{{"NVDA", "0.0010"}, {"MSFT", "0.0060"}} {
		var line string
		for _, l := range strings.Split(p, "\n") {
			if strings.HasPrefix(l, tc.sym) {
				line = l
				break
			}
		}
		if line == "" {
			t.Fatalf("no market line for %s in:\n%s", tc.sym, p)
		}
		if !strings.Contains(line, tc.want) {
			t.Fatalf("%s's line does not carry its own bound %s: %q", tc.sym, tc.want, line)
		}
	}
}

// Without a broker there is no pool, so there is no round trip to state, and the
// table must not grow a column of nothing.
func TestWithNoPoolTheTableSaysNothingAboutBounds(t *testing.T) {
	in := DeciderInput{
		View: marketView{
			symbols: []marketdata.Quote{{Symbol: "NVDA"}},
			prices:  map[string]float64{"NVDA": 219.0},
		},
	}
	p := buildPrompt(in)
	if strings.Contains(p, "smallest level this pool accepts") {
		t.Fatalf("the paper path advertises a pool bound it does not have:\n%s", p)
	}
}

// The prose must send the reader to the column rather than restating one number,
// and must say that a level is measured against the realizable price — the thing
// that makes "how far away is it" from the mid price wrong.
func TestThePromptExplainsWhereTheBoundComesFrom(t *testing.T) {
	for _, want := range []string{"per symbol", "realizable"} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("the prompt never mentions %q, so the model is left to guess", want)
		}
	}
	if strings.Contains(systemPrompt, "0.001 on the tight pools") {
		t.Fatal("the prompt still states one pair of numbers for every symbol, which is the " +
			"shape that left four of nine symbols unguarded")
	}
}
