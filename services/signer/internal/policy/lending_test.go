package policy

import (
	"math/big"
	"os"
	"strings"
	"testing"
)

const shipped = "../../allowlist/robinhood-mainnet.json"
const marketID = "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc"

func usdg(whole int64) *big.Int { return new(big.Int).Mul(big.NewInt(whole), big.NewInt(1_000000)) }

func load(t *testing.T) *Allowlist {
	t.Helper()
	a, err := Load(shipped)
	if err != nil {
		t.Fatalf("the shipped allowlist does not load: %v", err)
	}
	if a.Lending == nil {
		t.Fatal("the shipped allowlist has no lending section")
	}
	return a
}

// WITH `enabled` FALSE, EVERY LENDING INTENT REFUSES. Tested on the shipped
// file with the switch forced off, so the refusal is proved whichever way the
// reviewed file currently sets it (it was enabled on 2026-09-25 for the first
// live borrow).
func TestLendingDisabledRefusesEverything(t *testing.T) {
	a := load(t)
	a.Lending.Enabled = false
	for name, r := range map[string]*Refusal{
		"supply":   func() *Refusal { _, _, r := a.CheckSupply(marketID, big.NewInt(1)); return r }(),
		"borrow":   func() *Refusal { _, _, r := a.CheckBorrow(marketID, usdg(1), big.NewInt(0)); return r }(),
		"repay":    func() *Refusal { _, _, r := a.CheckRepay(marketID, usdg(1)); return r }(),
		"withdraw": func() *Refusal { _, _, r := a.CheckWithdraw(marketID, big.NewInt(1)); return r }(),
		"approve": func() *Refusal {
			_, r := a.CheckLendingApprove(marketID, a.QuoteToken.Address, usdg(1))
			return r
		}(),
	} {
		if r == nil || r.Code != CodeLendingDisabled {
			t.Errorf("%s: want %s, got %v", name, CodeLendingDisabled, r)
		}
	}
}

// THE UNITS. §17.7: "a cap that is off by 10^12 is not a cap". The file says
// 100 and 250 whole USDG; the comparison must happen in 6-decimal base units.
func TestCapsAreConvertedToBaseUnits(t *testing.T) {
	a := load(t)
	if got, want := a.MaxBorrowPerTx(), usdg(100); got.Cmp(want) != 0 {
		t.Fatalf("per-tx cap is %s base units, want %s (100 USDG)", got, want)
	}
	if got, want := a.MaxDebtPerAgent(), usdg(250); got.Cmp(want) != 0 {
		t.Fatalf("per-agent cap is %s base units, want %s (250 USDG)", got, want)
	}
}

func enabled(t *testing.T) *Allowlist {
	a := load(t)
	a.Lending.Enabled = true
	return a
}

func TestBorrowCaps(t *testing.T) {
	a := enabled(t)
	cases := []struct {
		name    string
		amount  *big.Int
		debt    *big.Int
		wantErr string
	}{
		{"within both caps", usdg(100), usdg(150), ""},
		{"one base unit over the per-tx cap", new(big.Int).Add(usdg(100), big.NewInt(1)), usdg(0), CodeBorrowOverTxCap},
		{"a whole-USDG number mistaken for base units is tiny, not huge", big.NewInt(100), usdg(0), ""},
		{"a base-unit number read as 18 decimals is refused", new(big.Int).Mul(usdg(100), big.NewInt(1_000000_000000)), usdg(0), CodeBorrowOverTxCap},
		{"debt would reach the cap exactly", usdg(50), usdg(200), ""},
		{"debt would pass the cap by one base unit", usdg(50), new(big.Int).Add(usdg(200), big.NewInt(1)), CodeDebtOverAgentCap},
		{"debt could not be read", usdg(1), nil, CodeChainUnverifiable},
		{"zero", big.NewInt(0), usdg(0), CodeAmountNotPositive},
	}
	for _, c := range cases {
		_, _, r := a.CheckBorrow(marketID, c.amount, c.debt)
		got := ""
		if r != nil {
			got = r.Code
		}
		if got != c.wantErr {
			t.Errorf("%s: want %q, got %q (%v)", c.name, c.wantErr, got, r)
		}
	}
}

func TestUnknownMarketAndWrongToken(t *testing.T) {
	a := enabled(t)
	if _, _, r := a.CheckSupply("0x"+strings.Repeat("ab", 32), big.NewInt(1)); r == nil || r.Code != CodeMarketNotListed {
		t.Errorf("unknown market: want %s, got %v", CodeMarketNotListed, r)
	}
	aapl := "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" // allowlisted, but not this market's
	if _, r := a.CheckLendingApprove(marketID, aapl, big.NewInt(1)); r == nil || r.Code != CodeLendingTokenWrong {
		t.Errorf("approve for another token: want %s, got %v", CodeLendingTokenWrong, r)
	}
	unbounded := new(big.Int).Lsh(big.NewInt(1), 255)
	if _, r := a.CheckLendingApprove(marketID, a.QuoteToken.Address, unbounded); r == nil || r.Code != CodeUnboundedApproval {
		t.Errorf("unbounded approve: want %s, got %v", CodeUnboundedApproval, r)
	}
	morpho, r := a.CheckLendingApprove(marketID, a.QuoteToken.Address, usdg(10))
	if r != nil || !strings.EqualFold(morpho, "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010") {
		t.Errorf("a bounded approve for the loan token should name Morpho as spender, got %q %v", morpho, r)
	}
}

// A file whose market id does not hash from its parameters must not load.
func TestTamperedMarketIDDoesNotLoad(t *testing.T) {
	raw, err := os.ReadFile(shipped)
	if err != nil {
		t.Fatal(err)
	}
	// Point the oracle at the excluded market's while keeping the reviewed id.
	bad := strings.Replace(string(raw),
		`"oracle": "0xC5b8A6C5fDF14f9744dB1C8595f49E42Ce23031a"`,
		`"oracle": "0xED29D310cfa91778A5850538DA28ed42234Cb78c"`, 1)
	if bad == string(raw) {
		t.Fatal("fixture did not change the oracle; the test would prove nothing")
	}
	p := t.TempDir() + "/allow.json"
	if err := os.WriteFile(p, []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "hash to") {
		t.Fatalf("a market whose oracle was swapped under its reviewed id loaded: %v", err)
	}
}
