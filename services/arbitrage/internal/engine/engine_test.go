package engine

import (
	"testing"

	"github.com/arcana/arbitrage/internal/config"
)

func quote(id, pool string, buy, sell float64) venueQuote {
	return venueQuote{venue: config.Venue{ID: id, Dex: "uniswap-v3", Pool: pool}, buy: buy, sell: sell}
}

// THE RULE THE SCANNER LEARNED ON 2026-10-20: a token with one pool has no
// arbitrage to report. Comparing a pool with itself measures the round trip
// through its own fee, and every single-venue token used to record exactly that
// as an opportunity.
func TestBestQuotePairRequiresTwoDistinctPools(t *testing.T) {
	if _, _, ok := bestQuotePair([]venueQuote{quote("uniswap-v3", "0xaa", 100, 99)}); ok {
		t.Fatal("a single venue produced a pair")
	}
	same := []venueQuote{
		quote("uniswap-v3", "0xAaAa", 100, 99),
		quote("uniswap-v3-referee", "0xaaaa", 100, 99),
	}
	if _, _, ok := bestQuotePair(same); ok {
		t.Fatal("the same pool under two names produced a pair")
	}
	if _, _, ok := bestQuotePair(nil); ok {
		t.Fatal("no venues produced a pair")
	}
}

func TestBestQuotePairPicksTheWidestDistinctSpread(t *testing.T) {
	quotes := []venueQuote{
		quote("a", "0x1", 100, 101),
		quote("b", "0x2", 99, 100),
		quote("c", "0x3", 98, 99.5),
	}
	buy, sell, ok := bestQuotePair(quotes)
	if !ok {
		t.Fatal("three distinct pools produced no pair")
	}
	// c is the cheapest place to buy (98) and a the dearest to sell (101).
	if buy.venue.ID != "c" || sell.venue.ID != "a" {
		t.Fatalf("chose %s→%s, expected c→a", buy.venue.ID, sell.venue.ID)
	}
}

// AN UNKNOWN RESERVE IS NOT A THIN RESERVE. Only V2 venues report one, and
// treating "we do not know" as "too small" would silently suppress every V3
// row.
func TestThinVenue(t *testing.T) {
	if !thinVenue(venueQuote{reserve: 99, reserveKnown: true}, 100) {
		t.Fatal("a pair holding less than the size read as able to carry it")
	}
	if thinVenue(venueQuote{reserve: 100, reserveKnown: true}, 100) {
		t.Fatal("a pair holding exactly the size read as thin")
	}
	if thinVenue(venueQuote{reserve: 0, reserveKnown: false}, 100) {
		t.Fatal("a venue with no reserve reading read as thin")
	}
}
