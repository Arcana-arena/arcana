package lp

import (
	"errors"
	"math"
	"math/big"
)

// PoolState is everything the planner needs from one pool. Token0/Token1 are in
// the pool's own ordering (the lower address is token0), and the USD prices are
// the human prices of one whole token each.
type PoolState struct {
	SqrtPriceX96 *big.Int
	Tick         int32
	TickSpacing  int32
	Token0       string
	Token1       string
	Dec0         int
	Dec1         int
	Token0USD    float64
	Token1USD    float64
}

// Plan is a concrete lp_mint ready to be sent to the signer: the ticks are
// snapped to the pool's spacing, the amounts are raw base units, and the min
// amounts carry the caller's slippage floor.
type Plan struct {
	TickLower      int32   `json:"tick_lower"`
	TickUpper      int32   `json:"tick_upper"`
	Amount0Desired string  `json:"amount0_desired"`
	Amount1Desired string  `json:"amount1_desired"`
	Amount0Min     string  `json:"amount0_min"`
	Amount1Min     string  `json:"amount1_min"`
	Liquidity      float64 `json:"liquidity"`
	SizeUSD        float64 `json:"size_usd"`
	CurrentTick    int32   `json:"current_tick"`
	SqrtPrice      float64 `json:"sqrt_price"`
}

// PlanFromState chooses a range around the current tick and sizes the two legs
// for targetUSD.
//
// THE RANGE IS SYMMETRIC IN PRICE, NOT IN TICKS. A ±rangePct move is
// log(1±rangePct)/log(1.0001) ticks on each side, which differ because price is
// exponential in tick. Using a symmetric tick delta would put half the quoted
// "percentage" on one side and a different one on the other.
func PlanFromState(st PoolState, targetUSD, rangePct, slippageBps float64) (*Plan, error) {
	if st.SqrtPriceX96 == nil || st.SqrtPriceX96.Sign() <= 0 {
		return nil, errors.New("pool sqrtPriceX96 is zero or uninitialised")
	}
	if !(targetUSD > 0) {
		return nil, errors.New("size_usd must be positive")
	}
	if !(rangePct > 0) || rangePct >= 1 {
		return nil, errors.New("range_pct must be in (0, 1)")
	}
	if st.TickSpacing <= 0 {
		return nil, errors.New("tick_spacing must be positive")
	}

	sqrtP := sqrtPriceFloat(st.SqrtPriceX96)
	deltaLo := math.Log(1-rangePct) / math.Log(1.0001)
	deltaHi := math.Log(1+rangePct) / math.Log(1.0001)
	tickLower := SnapTick(float64(st.Tick)+deltaLo, st.TickSpacing, false)
	tickUpper := SnapTick(float64(st.Tick)+deltaHi, st.TickSpacing, true)
	if tickLower >= tickUpper {
		return nil, errors.New("snapped range is empty; tick spacing is too coarse for this range_pct")
	}

	sqrtPa := TickToSqrtPrice(tickLower)
	sqrtPb := TickToSqrtPrice(tickUpper)

	L := LiquidityForValue(targetUSD, sqrtP, sqrtPa, sqrtPb, st.Token0USD, st.Token1USD, st.Dec0, st.Dec1)
	if !(L > 0) {
		return nil, errors.New("liquidity computes to zero; check the USD prices")
	}

	a0, a1 := AmountsForLiquidity(L, sqrtP, sqrtPa, sqrtPb)
	amount0 := floatToBig(a0)
	amount1 := floatToBig(a1)

	slip := slippageBps / 10000.0
	if slip < 0 {
		slip = 0
	}
	if slip >= 1 {
		slip = 0.9999
	}

	p := &Plan{
		TickLower:      tickLower,
		TickUpper:      tickUpper,
		Amount0Desired: amount0.String(),
		Amount1Desired: amount1.String(),
		Amount0Min:     scaleBig(amount0, 1-slip).String(),
		Amount1Min:     scaleBig(amount1, 1-slip).String(),
		Liquidity:      L,
		SizeUSD:        targetUSD,
		CurrentTick:    st.Tick,
		SqrtPrice:      sqrtP,
	}
	return p, nil
}

func sqrtPriceFloat(x *big.Int) float64 {
	f := new(big.Float).SetInt(x)
	d := new(big.Float).SetFloat64(math.Pow(2, 96))
	q := new(big.Float).Quo(f, d)
	v, _ := q.Float64()
	return v
}

// floatToBig converts an amount in raw units to an integer without going
// through uint64, which would overflow for large positions or cheap tokens.
func floatToBig(f float64) *big.Int {
	if !(f > 0) {
		return new(big.Int)
	}
	out, _ := new(big.Float).SetFloat64(f).Int(nil)
	return out
}

func scaleBig(v *big.Int, frac float64) *big.Int {
	f := new(big.Float).SetInt(v)
	f.Mul(f, big.NewFloat(frac))
	out, _ := f.Int(nil)
	return out
}
