package lp

import "math/big"

// Fee accounting, exactly as Uniswap v3 core computes it.
//
// THE POSITION MANAGER'S STORED tokensOwed IS NOT THE ACCRUAL. It is the
// amount written down the last time the position was touched. Everything that
// has accrued since lives in the pool's cumulative feeGrowth counters, and
// getting the current number means recomputing the same feeGrowthInside the
// contract recomputes at collect() time. This file is that computation, so a
// reader can show the exact accrual and — the point — so it can be CHECKED
// against a collect() simulation on the live contract.

// q128 is 2^128, the fixed-point denominator of the feeGrowth counters.
var q128 = new(big.Int).Lsh(big.NewInt(1), 128)

// mod256 bounds an integer to the 2^256 range the contract's unchecked
// arithmetic works in.
var mod256 = new(big.Int).Lsh(big.NewInt(1), 256)

// subMod256 is a - b with the same wrap-around as the contract's unchecked
// subtraction. The wrap is not a corner case to tolerate: feeGrowth counters
// are the only uint256 values in Uniswap that can realistically overflow, and
// the position manager subtracts them unchecked on purpose.
func subMod256(a, b *big.Int) *big.Int {
	d := new(big.Int).Sub(a, b)
	if d.Sign() < 0 {
		d.Add(d, mod256)
	}
	return d
}

// FeeGrowthInside returns the fee growth that has accumulated inside
// [tickLower, tickUpper) at tickCurrent.
//
// The rule from Uniswap v3 core: the global counter minus what grew below the
// range and above it. Each boundary's ticks() entry stores feeGrowthOutside —
// the growth on the OTHER side of that tick — so which side it represents is
// decided by where the current tick sits relative to the boundary. It is the
// branch direction that is easy to get backwards, and getting it backwards
// produces a number that looks plausible and refuses to match collect().
func FeeGrowthInside(fgGlobal, fgOutsideLower, fgOutsideUpper *big.Int, tickCurrent, tickLower, tickUpper int32) *big.Int {
	below := new(big.Int)
	if tickCurrent >= tickLower {
		below.Set(fgOutsideLower)
	} else {
		below.Sub(fgGlobal, fgOutsideLower)
	}

	above := new(big.Int)
	if tickCurrent < tickUpper {
		above.Set(fgOutsideUpper)
	} else {
		above.Sub(fgGlobal, fgOutsideUpper)
	}

	inside := new(big.Int).Sub(fgGlobal, below)
	inside.Sub(inside, above)
	return inside.Mod(inside, mod256)
}

// FeesOwed returns the exact fees a position is owed for one token right now:
// what the manager has stored, plus the growth since the position was last
// touched scaled by the position's liquidity.
//
//	fees = tokensOwed + liquidity * (feeGrowthInside − feeGrowthInsideLast) / 2^128
//
// The subtraction is modulo 2^256 and the division floors, both exactly as
// FullMath.mulDiv does in the contract. Any deviation here is the difference
// between this service's number and the number an owner receives when they
// collect.
func FeesOwed(liquidity, feeGrowthInsideLast, feeGrowthInside, tokensOwed *big.Int) *big.Int {
	if liquidity == nil || liquidity.Sign() == 0 {
		return new(big.Int).Set(tokensOwed)
	}
	delta := subMod256(feeGrowthInside, feeGrowthInsideLast)
	fees := new(big.Int).Mul(delta, liquidity)
	fees.Rsh(fees, 128)
	return fees.Add(fees, tokensOwed)
}
