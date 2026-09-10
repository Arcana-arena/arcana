package chain

import (
	"math"
	"testing"
	"time"
)

// The referee is the only thing standing between "the pool said so" and a
// score. So it is tested by being made to REFUSE, not by being shown a case it
// accepts — a check that has never turned anything away has not been tested,
// and this repository has three examples of exactly that shipping.

func testConfig() *Config {
	c := &Config{DisputeTolerancePct: 2.0, FeedMaxAgeSeconds: 86400}
	c.QuoteToken.Decimals = 6
	return c
}

func TestRefereeAgreesInsideTolerance(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	// The widest disagreement measured across all nine live symbols was 0.244%.
	v := Referee(cfg, TokenConfig{Symbol: "QQQ"}, 709.3876,
		FeedAnswer{Price: 711.1232, UpdatedAt: now.Add(-6 * time.Hour)}, nil, now)
	if v.Status != "agreed" {
		t.Fatalf("real measured pair should agree, got %s (%s)", v.Status, v.Note)
	}
	if math.Abs(v.DeviationPct-0.244) > 0.01 {
		t.Fatalf("deviation should be ~0.244%%, got %v", v.DeviationPct)
	}
	// Both numbers must survive. "They agreed" is only checkable later if the
	// figure that was agreed WITH is recorded too.
	if v.FeedPrice == 0 {
		t.Fatal("the referee price must be recorded even when the two agree")
	}
}

func TestRefereeDisputesAManipulatedPool(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	// A pool moved 10% is the scenario this exists for: someone with capital
	// pushing the price ahead of a tick so every agent reads their number.
	v := Referee(cfg, TokenConfig{Symbol: "AAPL"}, 359.0,
		FeedAnswer{Price: 326.4, UpdatedAt: now.Add(-time.Hour)}, nil, now)
	if v.Status != "disputed" {
		t.Fatalf("a 10%% move must be disputed, got %s", v.Status)
	}
	if v.Note == "" {
		t.Fatal("a dispute must say what it saw; a bare status is not evidence")
	}
	if v.PoolPrice != 359.0 || v.FeedPrice != 326.4 {
		t.Fatalf("both figures must survive a dispute, got pool=%v feed=%v", v.PoolPrice, v.FeedPrice)
	}
}

func TestRefereeDisputesInBothDirections(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	// Downward manipulation is the cheaper attack — pushing a price down to be
	// bought — and an absolute-value check is the only thing that catches it.
	v := Referee(cfg, TokenConfig{Symbol: "AAPL"}, 300.0,
		FeedAnswer{Price: 326.4, UpdatedAt: now.Add(-time.Hour)}, nil, now)
	if v.Status != "disputed" {
		t.Fatalf("a pool BELOW the feed must be disputed too, got %s", v.Status)
	}
}

func TestRefereeRefusesToRefereeWithAStaleFeed(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	// A feed that has stopped updating still answers, cheerfully, with its last
	// value. Refereeing with it would either wave through a real manipulation
	// or dispute an honest move, and the number alone cannot say which.
	v := Referee(cfg, TokenConfig{Symbol: "AAPL"}, 326.0,
		FeedAnswer{Price: 326.4, UpdatedAt: now.Add(-48 * time.Hour)}, nil, now)
	if v.Status != "unrefereed" {
		t.Fatalf("a two-day-old feed must not referee, got %s", v.Status)
	}
	if v.Note == "" {
		t.Fatal("unrefereed must say why")
	}
}

func TestUnrefereedIsNotAgreed(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	// THE ONE THAT MATTERS MOST. Collapsing "could not check" into "agreed"
	// removes the referee silently, on exactly the occasions it stopped
	// working — the same failure the 503 answers elsewhere in this codebase
	// exist to prevent.
	v := Referee(cfg, TokenConfig{Symbol: "AAPL"}, 326.0, FeedAnswer{}, errNoFeed, now)
	if v.Status == "agreed" {
		t.Fatal("an unreadable feed must never read as agreement")
	}
	if v.Status != "unrefereed" {
		t.Fatalf("expected unrefereed, got %s", v.Status)
	}
	if v.FeedPrice != 0 {
		t.Fatal("no feed price may be invented when the feed could not be read")
	}
}

func TestRefereeBoundaryIsExclusive(t *testing.T) {
	cfg := testConfig()
	now := time.Now().UTC()
	feed := 100.0
	// Exactly at tolerance agrees; a hair beyond disputes. Stated as a test
	// because "> or >=" on a threshold is decided once and then forgotten.
	at := Referee(cfg, TokenConfig{Symbol: "X"}, 102.0,
		FeedAnswer{Price: feed, UpdatedAt: now}, nil, now)
	if at.Status != "agreed" {
		t.Fatalf("exactly at tolerance should agree, got %s (%v%%)", at.Status, at.DeviationPct)
	}
	beyond := Referee(cfg, TokenConfig{Symbol: "X"}, 102.5,
		FeedAnswer{Price: feed, UpdatedAt: now}, nil, now)
	if beyond.Status != "disputed" {
		t.Fatalf("beyond tolerance should dispute, got %s", beyond.Status)
	}
}

func TestLoadConfigRefusesWhatItCannotUse(t *testing.T) {
	// Every one of these would otherwise produce a service that starts, looks
	// healthy, and prices something wrong.
	cases := []struct {
		name string
		json string
	}{
		{"no chain id", `{"tokens":[{"symbol":"A","address":"0x1","pool":"0x2","decimals":18}],"quote_token":{"decimals":6},"dispute_tolerance_pct":2,"feed_max_age_seconds":1}`},
		{"no tokens", `{"chain_id":4663,"tokens":[],"quote_token":{"decimals":6},"dispute_tolerance_pct":2,"feed_max_age_seconds":1}`},
		{"no quote decimals", `{"chain_id":4663,"tokens":[{"symbol":"A","address":"0x1","pool":"0x2","decimals":18}],"quote_token":{},"dispute_tolerance_pct":2,"feed_max_age_seconds":1}`},
		{"no tolerance", `{"chain_id":4663,"tokens":[{"symbol":"A","address":"0x1","pool":"0x2","decimals":18}],"quote_token":{"decimals":6},"feed_max_age_seconds":1}`},
		{"no feed age limit", `{"chain_id":4663,"tokens":[{"symbol":"A","address":"0x1","pool":"0x2","decimals":18}],"quote_token":{"decimals":6},"dispute_tolerance_pct":2}`},
		{"token without decimals", `{"chain_id":4663,"tokens":[{"symbol":"A","address":"0x1","pool":"0x2"}],"quote_token":{"decimals":6},"dispute_tolerance_pct":2,"feed_max_age_seconds":1}`},
		{"duplicate symbol", `{"chain_id":4663,"tokens":[{"symbol":"A","address":"0x1","pool":"0x2","decimals":18},{"symbol":"A","address":"0x3","pool":"0x4","decimals":18}],"quote_token":{"decimals":6},"dispute_tolerance_pct":2,"feed_max_age_seconds":1}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := t.TempDir() + "/cfg.json"
			if err := writeFile(path, c.json); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadConfig(path); err == nil {
				t.Fatalf("%s should have been refused", c.name)
			}
		})
	}
}

func TestWordToAddress(t *testing.T) {
	// A left-padded 32-byte word carrying an address in its low 20 bytes. Off
	// by one here and the pool's token ordering is read wrong, which inverts
	// every price into something that still looks like a number.
	w := "000000000000000000000000" + "2e0847e8910a9732eb3fb1bb4b70a580adad4fe3"
	if got := wordToAddress(w); got != "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3" {
		t.Fatalf("got %s", got)
	}
}
