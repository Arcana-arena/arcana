package execution

import (
	"math/big"
	"testing"
)

// A real Liquidate event, read from Morpho on chain 4663 on 2026-10-02 (block
// 0x4aa64ff, another market). The decoder is tested against what the chain
// actually emits, not against a log built by the code that reads it.
var realLiquidation = rawLog{
	Topics: []string{
		"0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41",
		"0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589",
		"0x00000000000000000000000072512e63c0c70797b96902228fa8acc1211b7cee",
		"0x00000000000000000000000074d09665900a5f29bac25befd30c73a5962d44e7",
	},
	Data: "0x" +
		"000000000000000000000000000000000000000000000000000000075d8fa4a7" +
		"000000000000000000000000000000000000000000000000006c206f013a7c2d" +
		"000000000000000000000000000000000000000000000001f6cb37956bb5c50c" +
		"0000000000000000000000000000000000000000000000000000000000000000" +
		"0000000000000000000000000000000000000000000000000000000000000000",
	BlockNumber: "0x4aa64ff",
	TxHash:      "0x63986a9f1d123b4c2bc55ccc3cb0a048bccf44f4a9eb952c5461a826ca71f75a",
	LogIndex:    "0x3",
}

func TestDecodeLiquidation(t *testing.T) {
	l, err := decodeLiquidation(realLiquidation)
	if err != nil {
		t.Fatal(err)
	}
	if l.Borrower != "0x74d09665900a5f29bac25befd30c73a5962d44e7" {
		t.Errorf("borrower = %s", l.Borrower)
	}
	if l.Liquidator != "0x72512e63c0c70797b96902228fa8acc1211b7cee" {
		t.Errorf("liquidator = %s", l.Liquidator)
	}
	if l.Block != 0x4aa64ff || l.LogIndex != 3 {
		t.Errorf("block %d, log index %d", l.Block, l.LogIndex)
	}
	// 0x75d8fa4a7 base units of a six-decimal loan token: 31,634.449575.
	if l.RepaidAssets.Cmp(big.NewInt(0x75d8fa4a7)) != 0 {
		t.Errorf("repaid = %s", l.RepaidAssets)
	}
	seized, _ := new(big.Int).SetString("1f6cb37956bb5c50c", 16)
	if l.SeizedAssets.Cmp(seized) != 0 {
		t.Errorf("seized = %s, want %s", l.SeizedAssets, seized)
	}
	if l.BadDebt.Sign() != 0 {
		t.Errorf("bad debt = %s", l.BadDebt)
	}
}

// The repaid amount is word 0 and the seized amount is word 2; word 1 is the
// repaid SHARES. Reading the wrong word would report shares as USDG.
func TestDecodeLiquidationDoesNotReadSharesAsAssets(t *testing.T) {
	l, err := decodeLiquidation(realLiquidation)
	if err != nil {
		t.Fatal(err)
	}
	shares, _ := new(big.Int).SetString("6c206f013a7c2d", 16)
	if l.RepaidAssets.Cmp(shares) == 0 || l.SeizedAssets.Cmp(shares) == 0 {
		t.Fatal("a share count was decoded as an asset amount")
	}
}

func TestDecodeLiquidationRefusesAnotherEvent(t *testing.T) {
	other := realLiquidation
	other.Topics = append([]string{"0x" + "11" + realLiquidation.Topics[0][4:]}, realLiquidation.Topics[1:]...)
	if _, err := decodeLiquidation(other); err == nil {
		t.Fatal("a log with another event's topic was decoded as a liquidation")
	}
	short := realLiquidation
	short.Data = realLiquidation.Data[:2+64*3]
	if _, err := decodeLiquidation(short); err == nil {
		t.Fatal("a log with three data words was decoded")
	}
}
