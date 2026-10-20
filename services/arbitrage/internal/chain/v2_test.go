package chain

import (
	"math/big"
	"testing"
)

func pow10(n int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}

func scaled(v int64, dec int) *big.Int {
	return new(big.Int).Mul(big.NewInt(v), pow10(dec))
}

// THE ORDERING IS READ, NOT ASSUMED. token0() says which side the token is on,
// so the same pair must price identically whichever side the token landed on —
// and the decimal correction must be applied exactly once.
func TestV2PriceFromReserves(t *testing.T) {
	token18 := scaled(1000, 18)     // 1000 tokens
	quote6 := scaled(340000, 6)     // 340,000 USDG
	cases := []struct {
		name     string
		reserve0 *big.Int
		reserve1 *big.Int
		tokenIs0 bool
		tokenDec int
		quoteDec int
		want     float64
	}{
		{"token is token0", token18, quote6, true, 18, 6, 340},
		{"token is token1", quote6, token18, false, 18, 6, 340},
		{"equal decimals", scaled(2, 6), scaled(1, 6), true, 6, 6, 0.5},
		{"one wei against one dollar", big.NewInt(1), scaled(1, 6), true, 18, 6, 1e-6},
	}
	for _, c := range cases {
		got, err := v2PriceFromReserves(c.reserve0, c.reserve1, c.tokenIs0, c.tokenDec, c.quoteDec)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if diff := got - c.want; diff > 1e-12 || diff < -1e-12 {
			t.Fatalf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// A PAIR WITH AN EMPTY SIDE HAS NO PRICE. Returning one would let a pair nobody
// has ever traded read as the cheapest venue in the scan.
func TestV2PriceFromReservesRejectsEmptySides(t *testing.T) {
	for _, c := range []struct {
		name     string
		r0, r1   *big.Int
		tokenIs0 bool
	}{
		{"token side empty", big.NewInt(0), scaled(1, 6), true},
		{"quote side empty", scaled(1, 18), big.NewInt(0), true},
		{"quote side empty, token is token1", big.NewInt(0), scaled(1, 18), false},
	} {
		if _, err := v2PriceFromReserves(c.r0, c.r1, c.tokenIs0, 18, 6); err == nil {
			t.Fatalf("%s: expected an error, got a price", c.name)
		}
	}
}
