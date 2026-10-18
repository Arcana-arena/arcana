package tx

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"
)

// The field order and the int24 sign extension are checked against hand-written
// expected words. The selector is the one verified on-chain (docs/liquidity-provision.md,
// Phase 2): eth_getCode of the NonfungiblePositionManager carries 0x88316456.
func TestEncodeMintFieldOrderAndSignExtension(t *testing.T) {
	p := MintParams{
		Token0:         "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
		Token1:         "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
		Fee:            500,
		TickLower:      -100,
		TickUpper:      100,
		Amount0Desired: big.NewInt(100_000_000),
		Amount1Desired: new(big.Int).Mul(big.NewInt(5), new(big.Int).Exp(big.NewInt(10), big.NewInt(17), nil)),
		Amount0Min:     big.NewInt(99_000_000),
		Amount1Min:     new(big.Int).Mul(big.NewInt(4), new(big.Int).Exp(big.NewInt(10), big.NewInt(17), nil)),
		Recipient:      self,
		Deadline:       big.NewInt(1700000000),
	}

	data := EncodeMint(p)
	if len(data) != 4+11*32 {
		t.Fatalf("mint calldata length = %d bytes, want %d", len(data), 4+11*32)
	}

	word := func(i int) string { return hex.EncodeToString(data[4+i*32 : 4+(i+1)*32]) }
	got := []string{
		hex.EncodeToString(data[:4]),
		word(0), word(1), word(2), word(3), word(4), word(5), word(6), word(7), word(8), word(9), word(10),
	}
	want := []string{
		"88316456",
		"0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168",
		"000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec",
		"00000000000000000000000000000000000000000000000000000000000001f4",
		strings.Repeat("f", 62) + "9c", // -100, sign-extended int24
		"0000000000000000000000000000000000000000000000000000000000000064", // 100
		"0000000000000000000000000000000000000000000000000000000005f5e100", // 1e8
		"00000000000000000000000000000000000000000000000006f05b59d3b20000", // 5e17
		"0000000000000000000000000000000000000000000000000000000005e69ec0", // 99e6
		"000000000000000000000000000000000000000000000000058d15e176280000", // 4e17
		"0000000000000000000000001111111111111111111111111111111111111111",
		"000000000000000000000000000000000000000000000000000000006553f100", // 1700000000
	}

	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("word %d differs\n got %s\nwant %s", i, got[i], want[i])
		}
	}
}

// padInt24 must sign-extend: a negative tick padded as if unsigned would read
// as an enormous positive number.
func TestPadInt24SignExtends(t *testing.T) {
	cases := []struct {
		in   int32
		want string
	}{
		{0, strings.Repeat("0", 64)},
		{100, strings.Repeat("0", 62) + "64"},
		{-1, strings.Repeat("f", 64)},
		{-100, strings.Repeat("f", 62) + "9c"},
		{-887272, strings.Repeat("f", 58) + "f27618"},
	}
	for _, c := range cases {
		got := hex.EncodeToString(padInt24(c.in))
		if got != c.want {
			t.Fatalf("padInt24(%d) = %s, want %s", c.in, got, c.want)
		}
	}
}
