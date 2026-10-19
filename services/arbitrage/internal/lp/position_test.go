package lp

import (
	"math/big"
	"testing"
)

func TestInRangeUpperIsExclusive(t *testing.T) {
	cases := []struct {
		cur, lo, hi int32
		want        bool
	}{
		{5, 0, 10, true},
		{0, 0, 10, true},   // lower inclusive
		{10, 0, 10, false}, // upper exclusive, per Uniswap v3 tick semantics
		{-1, 0, 10, false},
		{-887272, -887272, 887272, true},
	}
	for _, c := range cases {
		if got := InRange(c.cur, c.lo, c.hi); got != c.want {
			t.Fatalf("InRange(%d,%d,%d) = %v, want %v", c.cur, c.lo, c.hi, got, c.want)
		}
	}
}

func TestRecommend(t *testing.T) {
	liq := big.NewInt(1e15)
	if got := Recommend(true, liq); got != "hold" {
		t.Fatalf("in range with liquidity = %q, want hold", got)
	}
	if got := Recommend(false, liq); got != "rebalance" {
		t.Fatalf("out of range with liquidity = %q, want rebalance", got)
	}
	if got := Recommend(true, big.NewInt(0)); got != "empty" {
		t.Fatalf("zero liquidity = %q, want empty", got)
	}
}

func TestPositionValueZeroLiquidityIsZero(t *testing.T) {
	sqrtX96 := new(big.Int).Lsh(big.NewInt(1), 96)
	a0, a1 := PositionValue(big.NewInt(0), -100, 100, sqrtX96)
	if a0.Sign() != 0 || a1.Sign() != 0 {
		t.Fatalf("zero liquidity = (%s, %s), want (0, 0)", a0, a1)
	}
}
