package chain

import (
	"errors"
	"path/filepath"
	"testing"
)

// The secondary market has no Chainlink feed; a second pool referees it. The
// same rule as the feed referee: made to refuse, not only shown a pass.

func rblx() TokenConfig {
	return TokenConfig{Symbol: "RBLX", Market: MarketSecondary, PoolFee: 3000,
		Pool:        "0x1bdb8e3a79cb1a7f228808739311e23098d33d43",
		RefereePool: "0x2ef5945cd5664876b6481fdacfaa2942995a4da8", RefereePoolFee: 10000}
}

func TestRefereeByPoolAgreesOnTheListingSpread(t *testing.T) {
	// Measured 2026-09-27: the 0.3% pool at 46.5184, the 1% pool at 46.6693.
	v := RefereeByPool(testConfig(), rblx(), 46.5184, 46.6693, nil)
	if v.Status != "agreed" {
		t.Fatalf("the listing spread must agree, got %s (%s)", v.Status, v.Note)
	}
	if v.FeedPrice != 46.6693 {
		t.Fatal("the referee pool's price must be recorded even when the two agree")
	}
}

func TestRefereeByPoolDisputesAMovedPool(t *testing.T) {
	v := RefereeByPool(testConfig(), rblx(), 51.0, 46.6, nil)
	if v.Status != "disputed" || v.Note == "" {
		t.Fatalf("a pool 9%% from its referee must be disputed with a note, got %s (%q)", v.Status, v.Note)
	}
}

func TestRefereeByPoolUnreadableIsNotAgreement(t *testing.T) {
	for _, v := range []Verdict{
		RefereeByPool(testConfig(), rblx(), 46.5, 0, errors.New("slot0: timeout")),
		RefereeByPool(testConfig(), rblx(), 46.5, 0, nil),
	} {
		if v.Status != "unrefereed" || v.Note == "" {
			t.Fatalf("an unreadable referee pool must be unrefereed with a note, got %s (%q)", v.Status, v.Note)
		}
	}
}

func TestRefereePoolConfigReadsTheSecondPool(t *testing.T) {
	r := rblx().RefereePoolConfig()
	if r.Pool != rblx().RefereePool || r.PoolFee != 10000 || r.Address != rblx().Address {
		t.Fatalf("the referee view must swap only the pool, got %+v", r)
	}
}

func TestLoadConfigSecondaryRules(t *testing.T) {
	head := `{"chain_id":4663,"quote_token":{"symbol":"USDG","address":"0x5fc5","decimals":6},
	"dispute_tolerance_pct":2,"feed_max_age_seconds":86400,"tokens":[`
	tok := `{"symbol":"RBLX","sector":"Communication Services","address":"0xf0c4","decimals":18,` +
		`"pool":"0x1bdb","pool_fee":3000,`
	cases := map[string]struct {
		body string
		ok   bool
	}{
		"refereed by a second pool": {tok + `"market":"secondary","referee_pool":"0x2ef5","referee_pool_fee":10000}`, true},
		"no referee pool":           {tok + `"market":"secondary"}`, false},
		"refereed by itself":        {tok + `"market":"secondary","referee_pool":"0x1bdb","referee_pool_fee":3000}`, false},
		"secondary with a feed":     {tok + `"market":"secondary","feed":"0xfeed","referee_pool":"0x2ef5","referee_pool_fee":10000}`, false},
		"unknown market":            {tok + `"market":"otc"}`, false},
	}
	for name, c := range cases {
		p := filepath.Join(t.TempDir(), "chain.json")
		if err := writeFile(p, head+c.body+`]}`); err != nil {
			t.Fatal(err)
		}
		_, err := LoadConfig(p)
		if c.ok && err != nil {
			t.Errorf("%s: must load, got %v", name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: must not load", name)
		}
	}
}
