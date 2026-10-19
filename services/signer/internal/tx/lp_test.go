package tx

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"
)

// The selectors were confirmed in the live NonfungiblePositionManager bytecode:
// collect 0xfc6f7865, decreaseLiquidity 0x0c49ccbe, burn 0x42966c68.

func TestEncodeCollectShape(t *testing.T) {
	max128 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1))
	data := EncodeCollect(CollectParams{
		TokenID:    big.NewInt(12345),
		Recipient:  self,
		Amount0Max: max128,
		Amount1Max: max128,
	})
	if len(data) != 4+4*32 {
		t.Fatalf("collect calldata length = %d, want %d", len(data), 4+4*32)
	}
	want := "fc6f7865" +
		"0000000000000000000000000000000000000000000000000000000000003039" + // 12345
		"0000000000000000000000001111111111111111111111111111111111111111" +
		"00000000000000000000000000000000ffffffffffffffffffffffffffffffff" +
		"00000000000000000000000000000000ffffffffffffffffffffffffffffffff"
	if got := hex.EncodeToString(data); got != want {
		t.Fatalf("collect calldata\n got %s\nwant %s", got, want)
	}
}

func TestEncodeDecreaseLiquidityShape(t *testing.T) {
	data := EncodeDecreaseLiquidity(DecreaseLiquidityParams{
		TokenID:    big.NewInt(12345),
		Liquidity:  new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil),
		Amount0Min: big.NewInt(0),
		Amount1Min: big.NewInt(0),
		Deadline:   big.NewInt(1700000000),
	})
	if len(data) != 4+5*32 {
		t.Fatalf("decrease calldata length = %d, want %d", len(data), 4+5*32)
	}
	want := "0c49ccbe" +
		"0000000000000000000000000000000000000000000000000000000000003039" + // tokenId
		"0000000000000000000000000000000000000000000000000de0b6b3a7640000" + // 1e18
		"0000000000000000000000000000000000000000000000000000000000000000" + // amount0Min
		"0000000000000000000000000000000000000000000000000000000000000000" + // amount1Min
		"000000000000000000000000000000000000000000000000000000006553f100" // deadline 1700000000
	if got := hex.EncodeToString(data); got != want {
		t.Fatalf("decrease calldata\n got %s\nwant %s", got, want)
	}
}

func TestEncodeBurnShape(t *testing.T) {
	data := EncodeBurn(big.NewInt(12345))
	if len(data) != 4+32 {
		t.Fatalf("burn calldata length = %d, want %d", len(data), 4+32)
	}
	want := "42966c68" + "0000000000000000000000000000000000000000000000000000000000003039"
	if got := hex.EncodeToString(data); got != want {
		t.Fatalf("burn calldata\n got %s\nwant %s", got, want)
	}
}

// A large tokenId (a real one is six digits; the max uint256 is the bound) must
// not be truncated.
func TestEncodeBurnDoesNotTruncate(t *testing.T) {
	id, _ := new(big.Int).SetString(strings.Repeat("f", 64), 16)
	data := EncodeBurn(id)
	want := "42966c68" + strings.Repeat("f", 64)
	if got := hex.EncodeToString(data); got != want {
		t.Fatalf("burn with max tokenId\n got %s\nwant %s", got, want)
	}
}
