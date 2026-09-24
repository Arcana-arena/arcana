package capital

import (
	"math"
	"strings"
	"testing"
)

var mandate = Mandate{MinHealthFactor: 2, MaxBorrowRateBps: 800, LiquidityTriggerUSDG: 50, MaxBorrowUSDG: 150}

// 2 NVDA posted at ~$223, LLTV 62.5%: worst-case borrowing power at HF 2 is
// 2 * 220 * 0.625 / 2 = 137.5 USDG (pool 220 is under the oracle 223).
func base() State {
	return State{
		CollateralQty: 2, DebtUSDG: 0, LLTV: 0.625, OraclePrice: 223, PoolPrice: 220,
		WalletCollateral: 1, WalletUSDG: 10, BorrowRateBps: 3, AvailableUSDG: 6000,
		PlatformDebtCapUSDG: 250, PlatformTxCapUSDG: 100,
	}
}

func near(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestBorrowsUpToTheTrigger(t *testing.T) {
	a := Decide(mandate, base())
	if a.Kind != Borrow || a.Reason != "liquidity_below_trigger" {
		t.Fatalf("want a borrow, got %+v", a)
	}
	near(t, "borrow", a.Amount, 40) // trigger 50 - wallet 10
	if r := Validate(a, mandate, base()); r != nil {
		t.Fatalf("the decider's own answer was refused: %v", r)
	}
}

func TestBorrowIsBoundedByTheFloorOnTheWorstPrice(t *testing.T) {
	s := base()
	s.DebtUSDG = 120 // ceiling 137.5 on the pool price, not 139.4 on the oracle
	s.WalletCollateral = 0
	a := Decide(mandate, s)
	near(t, "borrow", a.Amount, 137.5*0.999-120) // the ceiling keeps 0.1% inside the floor
}

func TestSuppliesCollateralWhenTheFloorLeavesNoRoom(t *testing.T) {
	s := base()
	s.DebtUSDG = 137.5
	a := Decide(mandate, s)
	if a.Kind != Supply {
		t.Fatalf("want supply, got %+v", a)
	}
	if a.Amount > s.WalletCollateral {
		t.Fatalf("supplied more than the wallet holds: %+v", a)
	}
}

func TestRepaysUnderTheFloor(t *testing.T) {
	s := base()
	s.DebtUSDG = 100  // HF = 2*220*0.625/100 = 2.75 ... push the price down
	s.PoolPrice = 150 // HF = 2*150*0.625/100 = 1.875 < 2
	s.WalletUSDG = 60
	a := Decide(mandate, s)
	if a.Kind != Repay || a.Reason != "health_below_floor" {
		t.Fatalf("want a repay, got %+v", a)
	}
	// target debt = 2*150*0.625/(2*1.1) = 85.227..., so repay 14.77
	near(t, "repay", a.Amount, 100-2*150*0.625/2.2)
	after := s
	after.DebtUSDG -= a.Amount
	if hf := after.HealthAt(after.CollateralQty, after.DebtUSDG); hf < mandate.MinHealthFactor {
		t.Fatalf("the repay left the position under the floor: %.3f", hf)
	}
}

func TestRepaysTheExcess(t *testing.T) {
	s := base()
	s.DebtUSDG = 40
	s.WalletUSDG = 130
	a := Decide(mandate, s)
	if a.Kind != Repay || a.Reason != "excess_liquidity" {
		t.Fatalf("want an excess repay, got %+v", a)
	}
	near(t, "repay", a.Amount, 40)
}

func TestNoBorrowAboveTheRate(t *testing.T) {
	s := base()
	s.BorrowRateBps = 900
	if a := Decide(mandate, s); a.Kind != Hold || a.Reason != "rate_above_mandate" {
		t.Fatalf("want hold on rate, got %+v", a)
	}
}

func TestNoBorrowOnAnUntrustedOracle(t *testing.T) {
	s := base()
	s.OracleUntrusted, s.OracleWhy = true, "the NVDA feed is 30 hours old"
	if a := Decide(mandate, s); a.Kind != Hold || a.Reason != "oracle_untrusted" {
		t.Fatalf("want hold on the oracle, got %+v", a)
	}
}

// THE CASE DAY 6 NAMES: a plausible borrow that breaches the mandate. Each is
// what an LLM might answer; each must be refused after the answer, in code.
func TestValidateRefusesPlausibleBreaches(t *testing.T) {
	cases := []struct {
		name string
		a    Action
		s    func(State) State
		code string
	}{
		{"over the mandate's borrow cap", Action{Kind: Borrow, Amount: 100},
			func(s State) State { s.DebtUSDG = 60; s.CollateralQty = 10; return s }, "over_mandate_borrow_cap"},
		// 1 NVDA at the worst price 220: 220*0.625/90 = 1.53, under the floor of 2.
		{"under the health floor", Action{Kind: Borrow, Amount: 90},
			func(s State) State { s.CollateralQty = 1; return s }, "below_health_floor"},
		{"over the platform's per-tx cap", Action{Kind: Borrow, Amount: 101},
			func(s State) State { s.CollateralQty = 100; return s }, "borrow_over_tx_cap"},
		{"while the rate is above the mandate", Action{Kind: Borrow, Amount: 5},
			func(s State) State { s.BorrowRateBps = 801; return s }, "rate_above_mandate"},
		{"on a stale oracle", Action{Kind: Borrow, Amount: 5},
			func(s State) State { s.OracleUntrusted, s.OracleWhy = true, "stale"; return s }, "oracle_untrusted"},
		{"more than the market has", Action{Kind: Borrow, Amount: 30},
			func(s State) State { s.AvailableUSDG = 20; return s }, "market_liquidity"},
		{"a repay the wallet cannot pay", Action{Kind: Repay, Amount: 50},
			func(s State) State { s.DebtUSDG = 100; return s }, "insufficient_usdg"},
		{"a repay larger than the debt", Action{Kind: Repay, Amount: 9},
			func(s State) State { s.DebtUSDG = 5; return s }, "repay_over_debt"},
		{"collateral the wallet does not hold", Action{Kind: Supply, Amount: 2},
			func(s State) State { return s }, "insufficient_collateral_in_wallet"},
		{"an action that is not one", Action{Kind: "transfer", Amount: 1},
			func(s State) State { return s }, "unknown_capital_action"},
		{"a negative borrow", Action{Kind: Borrow, Amount: -5},
			func(s State) State { return s }, "amount_not_positive"},
		{"NaN", Action{Kind: Borrow, Amount: math.NaN()},
			func(s State) State { return s }, "amount_not_positive"},
	}
	for _, c := range cases {
		r := Validate(c.a, mandate, c.s(base()))
		if r == nil || r.Code != c.code {
			t.Errorf("%s: want %s, got %v", c.name, c.code, r)
		}
	}
}

// A mandate cannot raise the platform's cap: 300 in the mandate, 250 at the
// platform, the platform wins.
func TestMandateCannotRaiseThePlatformCap(t *testing.T) {
	m := mandate
	m.MaxBorrowUSDG = 300
	s := base()
	s.CollateralQty, s.DebtUSDG = 100, 200
	r := Validate(Action{Kind: Borrow, Amount: 60}, m, s)
	if r == nil || r.Code != "debt_over_agent_cap" {
		t.Fatalf("want debt_over_agent_cap, got %v", r)
	}
}

func TestNeverSell(t *testing.T) {
	m := mandate
	m.NeverSell = []string{"NVDA"}
	if r := NeverSellRefusal(m, "SELL", "NVDA"); r == nil || !strings.Contains(r.Detail, "NVDA") {
		t.Fatalf("a sell of a never-sell symbol was not refused: %v", r)
	}
	if r := NeverSellRefusal(m, "BUY", "NVDA"); r != nil {
		t.Fatalf("a buy was refused: %v", r)
	}
	if r := NeverSellRefusal(m, "SELL", "AAPL"); r != nil {
		t.Fatalf("an unlisted sell was refused: %v", r)
	}
}

// THE LIVE EDGE CASE, swept: whatever Decide sizes a borrow to, Validate must
// accept it. Without floorMargin, borrows sized exactly to the floor came
// back a float ulp under it and were refused by the rule they were sized to.
func TestDecidedBorrowAlwaysPassesValidate(t *testing.T) {
	for _, coll := range []float64{0.028049313660672240, 0.0536, 0.5, 1, 2.333, 7.77} {
		for _, price := range []float64{99.99, 211.3, 224.14, 224.4126, 333.33} {
			for _, hf := range []float64{1.5, 1.73, 2, 2.5, 3.1} {
				m := Mandate{MinHealthFactor: hf, MaxBorrowRateBps: 800, LiquidityTriggerUSDG: 200, MaxBorrowUSDG: 250}
				s := State{CollateralQty: coll, LLTV: 0.625, OraclePrice: price, PoolPrice: price,
					WalletUSDG: 1, BorrowRateBps: 3, AvailableUSDG: 1e6, PlatformDebtCapUSDG: 250, PlatformTxCapUSDG: 100}
				a := Decide(m, s)
				if a.Kind != Borrow {
					continue
				}
				if r := Validate(a, m, s); r != nil {
					t.Errorf("coll=%v price=%v floor=%v: Decide proposed %v and Validate refused it: %v", coll, price, hf, a.Amount, r)
				}
			}
		}
	}
}

// WITHDRAW, by the owner's hand: never more than is posted, and with debt
// outstanding never under the floor or on a price nobody can trust.
func TestValidateWithdraw(t *testing.T) {
	cases := []struct {
		name string
		a    Action
		s    func(State) State
		code string
	}{
		{"everything, with no debt", Action{Kind: Withdraw, Amount: 2}, func(s State) State { return s }, ""},
		{"more than is posted", Action{Kind: Withdraw, Amount: 2.0001}, func(s State) State { return s }, "withdraw_over_collateral"},
		// 2 NVDA, 50 owed, worst 220: keeping 1 gives 1*220*0.625/50 = 2.75, fine.
		{"half, with debt the rest still covers", Action{Kind: Withdraw, Amount: 1},
			func(s State) State { s.DebtUSDG = 50; return s }, ""},
		// Keeping 0.5 gives 0.5*220*0.625/50 = 1.375, under the floor of 2.
		{"too much, with debt", Action{Kind: Withdraw, Amount: 1.5},
			func(s State) State { s.DebtUSDG = 50; return s }, "below_health_floor"},
		{"any amount with debt on an untrusted oracle", Action{Kind: Withdraw, Amount: 0.1},
			func(s State) State { s.DebtUSDG = 50; s.OracleUntrusted, s.OracleWhy = true, "stale"; return s }, "oracle_untrusted"},
		{"an untrusted oracle does not lock collateral that backs nothing", Action{Kind: Withdraw, Amount: 2},
			func(s State) State { s.OracleUntrusted, s.OracleWhy = true, "stale"; return s }, ""},
	}
	for _, c := range cases {
		r := Validate(c.a, mandate, c.s(base()))
		got := ""
		if r != nil {
			got = r.Code
		}
		if got != c.code {
			t.Errorf("%s: want %q, got %q (%v)", c.name, c.code, got, r)
		}
	}
}

// Decide never proposes a withdrawal; it is the owner's hand only.
func TestDecideNeverWithdraws(t *testing.T) {
	for _, debt := range []float64{0, 10, 100, 137} {
		for _, cash := range []float64{0, 10, 60, 500} {
			s := base()
			s.DebtUSDG, s.WalletUSDG = debt, cash
			if a := Decide(mandate, s); a.Kind == Withdraw {
				t.Fatalf("Decide proposed a withdrawal at debt=%v cash=%v", debt, cash)
			}
		}
	}
}

// go-no-go-lending.md condition 4: a pool and an oracle that disagree by more
// than the band stop new borrowing — and so does a pool nobody can read.
// Repaying is never stopped by it: reducing risk needs no trusted price.
func TestPriceDivergenceStopsBorrowingOnly(t *testing.T) {
	far := base()
	far.PoolPrice = 223 * 0.97 // 3% under the oracle
	if a := Decide(mandate, far); a.Kind != Hold || a.Reason != "price_divergence" {
		t.Fatalf("a 3%% divergence should hold the borrow, got %+v", a)
	}
	if r := Validate(Action{Kind: Borrow, Amount: 5}, mandate, far); r == nil || r.Code != "price_divergence" {
		t.Fatalf("Validate should refuse a borrow on a 3%% divergence, got %v", r)
	}
	blind := base()
	blind.PoolPrice = 0
	if r := Validate(Action{Kind: Borrow, Amount: 5}, mandate, blind); r == nil || r.Code != "price_divergence" {
		t.Fatalf("Validate should refuse a borrow with no pool price, got %v", r)
	}
	near := base()
	near.PoolPrice = 223 * 0.985 // 1.5%, inside the band
	if r := Validate(Action{Kind: Borrow, Amount: 5}, mandate, near); r != nil {
		t.Fatalf("1.5%% is inside the band and was refused: %v", r)
	}
	far.DebtUSDG, far.WalletUSDG = 40, 30
	if r := Validate(Action{Kind: Repay, Amount: 30}, mandate, far); r != nil {
		t.Fatalf("a repay was refused over a divergence: %v", r)
	}
}
