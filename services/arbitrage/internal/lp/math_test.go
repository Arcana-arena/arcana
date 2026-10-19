package lp

import (
	"math"
	"math/big"
	"testing"
)

func TestTickToSqrtPriceKnownValues(t *testing.T) {
	cases := []struct {
		tick int32
		want float64
	}{
		{0, 1},
		{6932, math.Sqrt2},   // 1.0001^6932 ~= 2
		{-6932, 1 / math.Sqrt2},
	}
	for _, c := range cases {
		got := TickToSqrtPrice(c.tick)
		if math.Abs(got-c.want) > 0.001 {
			t.Fatalf("TickToSqrtPrice(%d) = %.6f, want ~%.6f", c.tick, got, c.want)
		}
	}
}

func TestAmountsForLiquidityInRange(t *testing.T) {
	L := 1e18
	sqrtP, sqrtPa, sqrtPb := 1.0, 0.9, 1.1
	a0, a1 := AmountsForLiquidity(L, sqrtP, sqrtPa, sqrtPb)

	want0 := 1e18 * (1.1 - 1.0) / (1.0 * 1.1)
	want1 := 1e18 * (1.0 - 0.9)
	if math.Abs(a0-want0)/want0 > 1e-9 {
		t.Fatalf("amount0 = %.6f, want %.6f", a0, want0)
	}
	if math.Abs(a1-want1)/want1 > 1e-9 {
		t.Fatalf("amount1 = %.6f, want %.6f", a1, want1)
	}
}

func TestAmountsForLiquidityOutOfRange(t *testing.T) {
	// Below the range: all token0, no token1.
	a0, a1 := AmountsForLiquidity(1e18, 0.8, 0.9, 1.1)
	if a0 <= 0 || a1 != 0 {
		t.Fatalf("below range: got (%.3f, %.3f), want (token0, 0)", a0, a1)
	}
	// Above the range: all token1, no token0.
	a0, a1 = AmountsForLiquidity(1e18, 1.2, 0.9, 1.1)
	if a0 != 0 || a1 <= 0 {
		t.Fatalf("above range: got (%.3f, %.3f), want (0, token1)", a0, a1)
	}
}

func TestLiquidityForValueRoundTrip(t *testing.T) {
	L := 2.0e22
	sqrtP, sqrtPa, sqrtPb := 1.0, 0.97434, 1.02480
	const dec0, dec1 = 18, 18
	const usd0, usd1 = 1.0, 1.0

	a0, a1 := AmountsForLiquidity(L, sqrtP, sqrtPa, sqrtPb)
	value := a0/math.Pow(10, dec0)*usd0 + a1/math.Pow(10, dec1)*usd1

	got := LiquidityForValue(value, sqrtP, sqrtPa, sqrtPb, usd0, usd1, dec0, dec1)
	if math.Abs(got-L)/L > 1e-6 {
		t.Fatalf("LiquidityForValue round trip = %.6f, want %.6f", got, L)
	}
}

func TestSnapTickHandlesNegatives(t *testing.T) {
	cases := []struct {
		tick    float64
		spacing int32
		up      bool
		want    int32
	}{
		{-3.2, 10, false, -10},
		{-3.2, 10, true, 0},
		{13.2, 10, false, 10},
		{13.2, 10, true, 20},
		{-520.0, 10, false, -520},
	}
	for _, c := range cases {
		got := SnapTick(c.tick, c.spacing, c.up)
		if got != c.want {
			t.Fatalf("SnapTick(%.1f, %d, up=%v) = %d, want %d", c.tick, c.spacing, c.up, got, c.want)
		}
	}
}

func TestPlanConservesValue(t *testing.T) {
	// sqrtPriceX96 = 2^96 means raw price 1 (tick 0).
	st := PoolState{
		SqrtPriceX96: new(big.Int).Lsh(big.NewInt(1), 96),
		Tick:         0,
		TickSpacing:  10,
		Token0:       "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
		Token1:       "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
		Dec0:         18,
		Dec1:         18,
		Token0USD:    1,
		Token1USD:    1,
	}

	p, err := PlanFromState(st, 1000, 0.05, 50)
	if err != nil {
		t.Fatalf("PlanFromState: %v", err)
	}
	if p.TickLower >= p.TickUpper {
		t.Fatalf("range not ordered: %d >= %d", p.TickLower, p.TickUpper)
	}
	if p.TickLower%st.TickSpacing != 0 || p.TickUpper%st.TickSpacing != 0 {
		t.Fatalf("ticks are not multiples of spacing %d: %d, %d", st.TickSpacing, p.TickLower, p.TickUpper)
	}
	if !(p.TickLower < 0 && p.TickUpper > 0) {
		t.Fatalf("range does not straddle the current tick 0: %d..%d", p.TickLower, p.TickUpper)
	}

	a0, _ := new(big.Int).SetString(p.Amount0Desired, 10)
	a1, _ := new(big.Int).SetString(p.Amount1Desired, 10)
	value := float64(a0.Int64())/1e18 + float64(a1.Int64())/1e18
	if math.Abs(value-1000) > 1 {
		t.Fatalf("plan value = %.4f USD, want ~1000", value)
	}
}
