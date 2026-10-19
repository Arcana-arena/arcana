// Package lp implements the Uniswap v3 concentrated-liquidity math the LP
// engine needs to choose a range and size the two legs, plus the planner that
// turns a live pool state into a concrete lp_mint plan.
//
// THE MATH IS THE PRODUCT HERE. A market-making engine that gets the tick or
// the amount wrong does not lose a little; it deposits the wrong ratio, gets
// refunded one side, and watches its position sit out of range. The formulas
// below are the Uniswap v3 whitepaper's, in raw units, and math_test.go pins
// them to known values.
package lp

import "math"

// TickToSqrtPrice returns sqrt(1.0001^tick), the raw sqrt price at a tick.
func TickToSqrtPrice(tick int32) float64 {
	return math.Pow(1.0001, float64(tick)/2)
}

// AmountsForLiquidity returns the raw token0 and token1 amounts a position with
// liquidity L holds in the range [sqrtPa, sqrtPb] at the current sqrt price
// sqrtP. All four are raw (base-unit) quantities:
//
//	amount0 = L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb)
//	amount1 = L * (sqrtP - sqrtPa)
//
// Below the range the position is all token0; above it, all token1.
func AmountsForLiquidity(L, sqrtP, sqrtPa, sqrtPb float64) (amount0, amount1 float64) {
	switch {
	case sqrtP < sqrtPa:
		return L * (sqrtPb - sqrtPa) / (sqrtPa * sqrtPb), 0
	case sqrtP > sqrtPb:
		return 0, L * (sqrtPb - sqrtPa)
	default:
		return L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb), L * (sqrtP - sqrtPa)
	}
}

// LiquidityForValue returns the L whose position is worth targetUSD at the
// current price, given each token's USD price and base-unit decimals. The value
// is linear in L, so this is one division rather than a search.
func LiquidityForValue(targetUSD, sqrtP, sqrtPa, sqrtPb, token0USD, token1USD float64, dec0, dec1 int) float64 {
	a0, a1 := AmountsForLiquidity(1, sqrtP, sqrtPa, sqrtPb)
	perUnit := a0/math.Pow(10, float64(dec0))*token0USD + a1/math.Pow(10, float64(dec1))*token1USD
	if perUnit <= 0 {
		return 0
	}
	return targetUSD / perUnit
}

// SnapTick rounds a tick to a multiple of the pool's tick spacing. Down for a
// lower bound, up for an upper bound, so the snapped range is never narrower
// than asked. math.Floor/Ceil handle negative ticks correctly; integer division
// in Go truncates toward zero and would move a negative lower bound the wrong
// way.
func SnapTick(tick float64, spacing int32, up bool) int32 {
	if spacing <= 0 {
		return int32(tick)
	}
	f := tick / float64(spacing)
	var s float64
	if up {
		s = math.Ceil(f)
	} else {
		s = math.Floor(f)
	}
	out := int32(s) * spacing
	if out < MinTick {
		return MinTick
	}
	if out > MaxTick {
		return MaxTick
	}
	return out
}

const (
	// MinTick and MaxTick are Uniswap v3's full-range bounds.
	MinTick = -887272
	MaxTick = 887272
)
