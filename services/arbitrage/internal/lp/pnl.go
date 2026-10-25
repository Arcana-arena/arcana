package lp

import (
	"math/big"
	"strings"
)

// FeeOnlyCollect reports whether one action's intents are a harvest: a collect
// with no leg that returns principal.
//
// WHY THIS EXISTS: the position manager emits the same Collect event whether a
// collect pays out fees alone or fees plus the tokens released by a decrease or
// a burn. Summing every Collect would book the owner's own capital as profit
// the first time a rebalance or close runs. Only an action whose intents are
// collect and nothing else can be counted as earned fees.
func FeeOnlyCollect(intents []string) bool {
	collect := false
	for _, raw := range intents {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "lp_collect":
			collect = true
		case "lp_decrease", "lp_burn", "lp_mint":
			return false
		}
	}
	return collect
}

// Human converts a raw chain integer to its decimal value through big.Rat, not
// through float64: a fee of 4.013e12 wei of an 18-decimal token is 0.000004013,
// and dividing by 1e18 in float64 would lose the digits that make it readable.
func Human(raw *big.Int, decimals int) float64 {
	if raw == nil {
		return 0
	}
	if decimals < 0 {
		decimals = 0
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	r := new(big.Rat).SetInt(raw)
	r.Quo(r, new(big.Rat).SetInt(scale))
	f, _ := r.Float64()
	return f
}

// ValueUSD prices a pair amount from the two per-token USD prices. A nil side
// contributes nothing (it is the same shape as a token that paid zero).
func ValueUSD(amount0, amount1 *big.Int, dec0, dec1 int, usd0, usd1 float64) float64 {
	return Human(amount0, dec0)*usd0 + Human(amount1, dec1)*usd1
}

// GasWei is gasUsed × gasPrice. nil when either factor is unknown: a missing
// price is not a free transaction, and returning zero here would understate
// cost on exactly the receipts a provider answered incompletely.
func GasWei(gasUsed, gasPrice *big.Int) *big.Int {
	if gasUsed == nil || gasPrice == nil {
		return nil
	}
	return new(big.Int).Mul(gasUsed, gasPrice)
}

// WeiETH converts wei to ETH.
func WeiETH(wei *big.Int) float64 {
	return Human(wei, 18)
}
