package store

import (
	"strings"
	"testing"
	"time"
)

func snapshotFixture() SnapshotManifestInput {
	return SnapshotManifestInput{
		PortfolioID:  "11111111-1111-4111-8111-111111111111",
		AgentID:      "22222222-2222-4222-8222-222222222222",
		SeasonID:     "33333333-3333-4333-8333-333333333333",
		TS:           time.Date(2026, 9, 14, 3, 47, 16, 763969000, time.UTC),
		NAV:          "10012.34",
		Cash:         "4000.00",
		Holdings:     map[string]any{"MSFT": 1.25, "AAPL": 3.0},
		PreviousSeal: strings.Repeat("a", 64),
	}
}

func TestSnapshotManifestIsDeterministic(t *testing.T) {
	a := BuildSnapshotManifest(snapshotFixture())
	b := BuildSnapshotManifest(snapshotFixture())
	if a != b {
		t.Fatal("the same snapshot rendered two different manifests")
	}
	if !strings.HasPrefix(a, PortfolioSnapshotScheme+"\n") {
		t.Fatalf("the manifest must open with its scheme:\n%s", a)
	}
	if !strings.Contains(a, `holdings: {"AAPL":3,"MSFT":1.25}`) {
		t.Fatalf("holdings must be a JSON object with sorted keys:\n%s", a)
	}
	if !strings.Contains(a, `ts: "2026-09-14T03:47:16.763969Z"`) {
		t.Fatalf("the timestamp must carry exactly six fractional digits:\n%s", a)
	}
}

func TestEverySnapshotFieldChangesTheSeal(t *testing.T) {
	base := Sha256Hex(BuildSnapshotManifest(snapshotFixture()))
	mutations := map[string]func(*SnapshotManifestInput){
		"portfolio": func(s *SnapshotManifestInput) { s.PortfolioID = "99999999-9999-4999-8999-999999999999" },
		"agent":     func(s *SnapshotManifestInput) { s.AgentID = "99999999-9999-4999-8999-999999999999" },
		"season":    func(s *SnapshotManifestInput) { s.SeasonID = "99999999-9999-4999-8999-999999999999" },
		"ts":        func(s *SnapshotManifestInput) { s.TS = s.TS.Add(time.Microsecond) },
		"nav":       func(s *SnapshotManifestInput) { s.NAV = "10012.35" },
		"cash":      func(s *SnapshotManifestInput) { s.Cash = "4000.01" },
		"holdings":  func(s *SnapshotManifestInput) { s.Holdings = map[string]any{"MSFT": 1.26, "AAPL": 3.0} },
		"previous":  func(s *SnapshotManifestInput) { s.PreviousSeal = strings.Repeat("b", 64) },
	}
	for name, mutate := range mutations {
		in := snapshotFixture()
		mutate(&in)
		if Sha256Hex(BuildSnapshotManifest(in)) == base {
			t.Errorf("changing %s did not change the seal", name)
		}
	}
}

func TestEmptyHoldingsAreAnObjectNotNull(t *testing.T) {
	in := snapshotFixture()
	in.Holdings = nil
	if !strings.Contains(BuildSnapshotManifest(in), "holdings: {}\n") {
		t.Fatal("empty holdings must render as {}, the value the NOT NULL column stores")
	}
}
