package lp

import "math/big"

// PositionState is a position read back from the chain, enriched with the
// current pool tick and the token amounts it holds at that price.
type PositionState struct {
	TokenID     string `json:"token_id"`
	Owner       string `json:"owner,omitempty"`
	Token0      string `json:"token0"`
	Token1      string `json:"token1"`
	Fee         uint32 `json:"fee"`
	TickLower   int32  `json:"tick_lower"`
	TickUpper   int32  `json:"tick_upper"`
	Liquidity   string `json:"liquidity"`
	TokensOwed0 string `json:"tokens_owed0"`
	TokensOwed1 string `json:"tokens_owed1"`
	// FeesOwed0/1 are the EXACT accrual: tokensOwed plus everything earned
	// since the position was last touched, recomputed from the pool's
	// feeGrowth counters (see FeesOwed). tokens_owed alone is only what the
	// position manager has written down, which is a stale lower bound.
	FeesOwed0      string `json:"fees_owed0"`
	FeesOwed1      string `json:"fees_owed1"`
	CurrentTick    int32  `json:"current_tick"`
	InRange        bool   `json:"in_range"`
	Amount0        string `json:"amount0"`
	Amount1        string `json:"amount1"`
	Recommendation string `json:"recommendation"`
}

// PositionValue returns the raw token0/token1 amounts a position holds at the
// current sqrt price. It reuses the same AmountsForLiquidity the planner sizes
// a mint with, so a mint and a readback cannot disagree about a range.
func PositionValue(liquidity *big.Int, tickLower, tickUpper int32, sqrtPriceX96 *big.Int) (*big.Int, *big.Int) {
	if liquidity == nil || liquidity.Sign() <= 0 {
		return new(big.Int), new(big.Int)
	}
	Lf, _ := new(big.Float).SetInt(liquidity).Float64()
	sqrtP := sqrtPriceFloat(sqrtPriceX96)
	a0, a1 := AmountsForLiquidity(Lf, sqrtP, TickToSqrtPrice(tickLower), TickToSqrtPrice(tickUpper))
	return floatToBig(a0), floatToBig(a1)
}

// InRange reports whether the current tick sits inside [tickLower, tickUpper).
// Upper is exclusive, matching Uniswap v3's tick semantics.
func InRange(currentTick, tickLower, tickUpper int32) bool {
	return currentTick >= tickLower && currentTick < tickUpper
}

// Recommend is the position manager's read-only verdict. "rebalance" means the
// price has left the range and the position is earning no fees; "empty" means
// liquidity is gone and only collect/burn remain; "hold" means it is still
// doing its job.
func Recommend(inRange bool, liquidity *big.Int) string {
	if liquidity == nil || liquidity.Sign() == 0 {
		return "empty"
	}
	if !inRange {
		return "rebalance"
	}
	return "hold"
}
