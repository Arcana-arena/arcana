package lp

import (
	"math/big"
	"testing"
)

func q128n(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), q128)
}

// In range: inside = global − outside(lower) − outside(upper).
func TestFeeGrowthInsideInRange(t *testing.T) {
	got := FeeGrowthInside(q128n(1000), q128n(100), q128n(200), 0, -100, 100)
	if got.Cmp(q128n(700)) != 0 {
		t.Fatalf("inside: got %s want %s", got, q128n(700))
	}
}

// Below the range: the position earns nothing, and DOES NOT START EARNING
// because the global counter grows — everything that accrues below the range
// is subtracted out again by the lower boundary.
func TestFeeGrowthInsideBelowRangeHasNoDelta(t *testing.T) {
	// outLower = 500, outUpper = 300, current tick below the range.
	a := FeeGrowthInside(q128n(1000), q128n(500), q128n(300), -200, -100, 100)
	b := FeeGrowthInside(q128n(1400), q128n(500), q128n(300), -200, -100, 100)
	if a.Cmp(q128n(200)) != 0 {
		t.Fatalf("inside below range: got %s want %s", a, q128n(200))
	}
	if a.Cmp(b) != 0 {
		t.Fatalf("global growth below the range must not move feeGrowthInside: %s vs %s", a, b)
	}
}

// Above the range, by symmetry.
func TestFeeGrowthInsideAboveRangeHasNoDelta(t *testing.T) {
	a := FeeGrowthInside(q128n(1000), q128n(300), q128n(500), 200, -100, 100)
	b := FeeGrowthInside(q128n(1400), q128n(300), q128n(500), 200, -100, 100)
	if a.Cmp(q128n(200)) != 0 {
		t.Fatalf("inside above range: got %s want %s", a, q128n(200))
	}
	if a.Cmp(b) != 0 {
		t.Fatalf("global growth above the range must not move feeGrowthInside: %s vs %s", a, b)
	}
}

// The delta scaled by liquidity, plus stored fees.
func TestFeesOwedScalesTheDeltaByLiquidity(t *testing.T) {
	liq := new(big.Int).Lsh(big.NewInt(1), 40) // 2^40
	last := q128n(690)
	inside := q128n(700) // delta = 10 * 2^128
	owed := big.NewInt(5)
	got := FeesOwed(liq, last, inside, owed)
	want := new(big.Int).Add(big.NewInt(10<<40), owed)
	if got.Cmp(want) != 0 {
		t.Fatalf("fees: got %s want %s", got, want)
	}
}

// The contract subtracts unchecked; when the last reading is ABOVE the current
// one (a wrapped uint256 counter), the difference wraps rather than going
// negative. Mirroring that is the difference between matching collect() and
// being off by 2^256.
func TestFeesOwedWrapsLikeTheContract(t *testing.T) {
	max := new(big.Int).Sub(mod256, big.NewInt(1))
	last := new(big.Int).Sub(mod256, big.NewInt(10)) // 2^256 − 10
	inside := big.NewInt(5)                          // wrapped past 2^256
	liq := new(big.Int).Lsh(big.NewInt(1), 128)
	got := FeesOwed(liq, last, inside, big.NewInt(0))
	// delta = 5 − (2^256 − 10) ≡ 15 (mod 2^256); fees = 15 * 2^128 / 2^128 = 15.
	if got.Cmp(big.NewInt(15)) != 0 {
		t.Fatalf("wrapped delta: got %s want 15 (last=%s max=%s)", got, last, max)
	}
}

// No liquidity means no new fees; the stored amount is all there is.
func TestFeesOwedZeroLiquidityIsStoredOnly(t *testing.T) {
	got := FeesOwed(new(big.Int), q128n(1), q128n(999), big.NewInt(7))
	if got.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("zero liquidity: got %s want 7", got)
	}
}

// A delta of zero (nothing accrued since the last touch) leaves stored fees
// untouched.
func TestFeesOwedZeroDelta(t *testing.T) {
	liq := big.NewInt(123456789)
	got := FeesOwed(liq, q128n(42), q128n(42), big.NewInt(99))
	if got.Cmp(big.NewInt(99)) != 0 {
		t.Fatalf("zero delta: got %s want 99", got)
	}
}
