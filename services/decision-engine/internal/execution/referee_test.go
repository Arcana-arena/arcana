package execution

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJudgeRefereeAgreesWithinTolerance(t *testing.T) {
	// The spread measured when RBLX was listed: 46.5184 against 46.6693.
	rc := RefereeCheck{PoolPrice: 46.5184, RefereePrice: 46.6693, DeviationPct: 0.3233}
	if code, note := judgeReferee("RBLX", rc); code != "" {
		t.Fatalf("0.32%% apart must trade, got %s: %s", code, note)
	}
}

func TestJudgeRefereeRefusesADivergence(t *testing.T) {
	rc := RefereeCheck{PoolPrice: 48, RefereePrice: 46.5, DeviationPct: 3.2258}
	code, note := judgeReferee("RBLX", rc)
	if code != CodePriceDivergence {
		t.Fatalf("3.2%% apart must be refused as %s, got %q", CodePriceDivergence, code)
	}
	if !strings.Contains(note, "RBLX") || !strings.Contains(note, "nothing was sent") {
		t.Fatalf("the refusal must name the symbol and say nothing was sent: %s", note)
	}
}

func TestJudgeRefereeRefusesAnUnusablePrice(t *testing.T) {
	for _, rc := range []RefereeCheck{{PoolPrice: 0, RefereePrice: 46}, {PoolPrice: 46, RefereePrice: 0}} {
		if code, _ := judgeReferee("RBLX", rc); code != CodeRefereeUnreadable {
			t.Fatalf("%+v must be %s, got %q", rc, CodeRefereeUnreadable, code)
		}
	}
}

func TestPrimaryTokenIsNeverRefereedHere(t *testing.T) {
	// No broker and no RPC: a primary token must return before touching either.
	var b Broker
	if code, _ := b.checkReferee(context.Background(), TokenCfg{Symbol: "AAPL", PoolFee: 500}); code != "" {
		t.Fatalf("a primary token is refereed by Chainlink in market-data, not here; got %s", code)
	}
}

func writeCfg(t *testing.T, token string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "allowlist.json")
	body := `{"chain_id":4663,"quote_token":{"symbol":"USDG","address":"0x5fc5","decimals":6},
	"routers":["0xcaf6"],"tokens":[` + token + `]}`
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadConfigSecondaryNeedsAReferee(t *testing.T) {
	cases := map[string]string{
		"no referee":     `{"symbol":"RBLX","address":"0xf0c4","decimals":18,"pool":"0x1bdb","pool_fee":3000,"market":"secondary"}`,
		"same fee tier":  `{"symbol":"RBLX","address":"0xf0c4","decimals":18,"pool":"0x1bdb","pool_fee":3000,"market":"secondary","referee_pool":"0x2ef5","referee_pool_fee":3000}`,
		"unknown market": `{"symbol":"RBLX","address":"0xf0c4","decimals":18,"pool":"0x1bdb","pool_fee":3000,"market":"tertiary"}`,
	}
	for name, tok := range cases {
		if _, err := LoadConfig(writeCfg(t, tok)); err == nil {
			t.Errorf("%s: must not load", name)
		}
	}
}

func TestLoadConfigSecondaryWithReferee(t *testing.T) {
	c, err := LoadConfig(writeCfg(t,
		`{"symbol":"RBLX","address":"0xf0c4","decimals":18,"pool":"0x1bdb","pool_fee":3000,"market":"secondary","referee_pool":"0x2ef5","referee_pool_fee":10000}`))
	if err != nil {
		t.Fatal(err)
	}
	tok, err := c.Token("rblx")
	if err != nil {
		t.Fatal(err)
	}
	if !tok.Secondary() || tok.RefereePoolFee != 10000 {
		t.Fatalf("RBLX must load as secondary refereed at 10000, got %+v", tok)
	}
}
