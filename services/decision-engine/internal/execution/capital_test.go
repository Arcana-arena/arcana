package execution

import (
	"math"
	"math/big"
	"testing"
)

func bi(s string) *big.Int { v, _ := new(big.Int).SetString(s, 10); return v }

// THE UNITS, on the numbers docs/go-no-go-lending.md recorded: 1 NVDA at the
// factory oracle's 223.177943965 USDG, 50 USDG owed, LLTV 62.5%. A decimal
// slip anywhere below moves these by powers of ten, not by rounding.
func TestValueUnits(t *testing.T) {
	s := MarketState{
		// Totals chosen so shares convert to assets exactly: S = A * 1e6.
		TotalBorrowAssets: bi("1000000000000"),
		TotalBorrowShares: bi("1000000000000000000"),
		OraclePrice:       bi("223177943965043146116849483"),
		PoolPrice:         210,
		CollateralSymbol:  "NVDA", CollateralDec: 18, LoanDec: 6,
		LLTV: bi("625000000000000000"),
	}
	p := LendingPosition{BorrowShares: bi("50000000000000"), Collateral: bi("1000000000000000000")}
	r := Value(p, s)

	near := func(name string, got, want, tol float64) {
		if math.Abs(got-want) > tol {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	near("collateral qty", r.CollateralQty, 1, 1e-12)
	near("debt", r.Debt, 50, 1e-9)
	near("oracle price", r.OraclePrice, 223.177943, 1e-5)
	near("collateral value", r.CollateralValue, 223.177943, 1e-5)
	near("lltv", r.LLTV, 0.625, 1e-12)
	if r.HealthFactor == nil || r.HealthFactorWorst == nil || r.LiquidationPrice == nil {
		t.Fatalf("a position with debt must carry a health factor and a liquidation price: %+v", r)
	}
	near("health factor", *r.HealthFactor, 223.177943*0.625/50, 1e-5)
	// The pool is lower than the oracle here, so the worst case uses it.
	near("worst health factor", *r.HealthFactorWorst, 210*0.625/50, 1e-9)
	near("liquidation price", *r.LiquidationPrice, 80, 1e-9)
}

// No debt is no health factor, not an infinite one.
func TestValueWithoutDebt(t *testing.T) {
	s := MarketState{
		TotalBorrowAssets: bi("0"), TotalBorrowShares: bi("0"),
		OraclePrice: bi("223177943965043146116849483"), CollateralDec: 18, LoanDec: 6,
		LLTV: bi("625000000000000000"),
	}
	r := Value(LendingPosition{BorrowShares: big.NewInt(0), Collateral: bi("2000000000000000000")}, s)
	if r.HealthFactor != nil || r.LiquidationPrice != nil {
		t.Fatalf("no debt produced a health factor: %+v", r)
	}
	if math.Abs(r.CollateralValue-446.355887) > 1e-5 {
		t.Fatalf("collateral value %v", r.CollateralValue)
	}
}

// Debt rounds UP, as Morpho values it: a cap or a health factor checked
// against a rounded-down debt is checked against less than is owed.
func TestDebtRoundsUp(t *testing.T) {
	s := MarketState{
		TotalBorrowAssets: bi("3"), TotalBorrowShares: bi("2000000"),
		OraclePrice: bi("1"), CollateralDec: 18, LoanDec: 6, LLTV: bi("625000000000000000"),
	}
	// 1e6 shares * (3 + 1) / (2e6 + 1e6) = 1.33 -> 2 base units.
	r := Value(LendingPosition{BorrowShares: big.NewInt(1_000000), Collateral: big.NewInt(0)}, s)
	if math.Abs(r.Debt-0.000002) > 1e-12 {
		t.Fatalf("debt %v, want 0.000002 (2 base units, rounded up)", r.Debt)
	}
}

// The book counts posted collateral as the agent's; the wallet can only sell
// what it actually holds.
func TestWalletUnitsExcludesPostedCollateral(t *testing.T) {
	p := &Position{
		Units:  map[string]*big.Int{"NVDA": bi("53569864393204191")},
		Posted: map[string]*big.Int{"NVDA": bi("28049313660672240")},
	}
	if got := p.WalletUnits("NVDA"); got.String() != "25520550732531951" {
		t.Fatalf("wallet units %s, want 25520550732531951", got)
	}
	if got := p.WalletUnits("AAPL"); got != nil {
		t.Fatalf("a symbol not held returned %v", got)
	}
	q := &Position{Units: map[string]*big.Int{"AAPL": bi("7")}}
	if got := q.WalletUnits("AAPL"); got.String() != "7" {
		t.Fatalf("with nothing posted the wallet holds everything, got %s", got)
	}
}
