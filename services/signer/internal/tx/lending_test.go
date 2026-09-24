package tx

import (
	"encoding/hex"
	"math/big"
	"testing"
)

// The expected bytes were produced by viem's encodeFunctionData — an encoder
// this package does not share code with — for the market docs/go-no-go-lending.md
// simulated on 2026-09-24. If these ever disagree, one of the two encoders is
// wrong, and the one that has been executed against the chain is viem's.
var market = MarketParams{
	LoanToken:       "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
	CollateralToken: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
	Oracle:          "0xC5b8A6C5fDF14f9744dB1C8595f49E42Ce23031a",
	IRM:             "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
	LLTV:            big.NewInt(625000000000000000),
}

const self = "0x1111111111111111111111111111111111111111"

const tuple = "0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168" +
	"000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec" +
	"000000000000000000000000c5b8a6c5fdf14f9744db1c8595f49e42ce23031a" +
	"0000000000000000000000002bd3d5965b26b51814ac95127b2b80dd6ccc0fa1" +
	"00000000000000000000000000000000000000000000000008ac7230489e8000"

const selfWord = "0000000000000000000000001111111111111111111111111111111111111111"

func TestEncodeSupplyCollateralMatchesViem(t *testing.T) {
	want := "238d6579" + tuple +
		"0000000000000000000000000000000000000000000000000de0b6b3a7640000" + // 1e18
		selfWord +
		"0000000000000000000000000000000000000000000000000000000000000100" + // offset of data
		"0000000000000000000000000000000000000000000000000000000000000000" // len(data) = 0
	got := hex.EncodeToString(EncodeSupplyCollateral(market, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), self))
	if got != want {
		t.Fatalf("supplyCollateral calldata differs from viem's\n got %s\nwant %s", got, want)
	}
}

func TestEncodeBorrowMatchesViem(t *testing.T) {
	want := "50d8cd4b" + tuple +
		"0000000000000000000000000000000000000000000000000000000002faf080" + // 50 USDG
		"0000000000000000000000000000000000000000000000000000000000000000" + // shares
		selfWord + selfWord
	got := hex.EncodeToString(EncodeBorrow(market, big.NewInt(50_000000), self))
	if got != want {
		t.Fatalf("borrow calldata differs from viem's\n got %s\nwant %s", got, want)
	}
}

func TestEncodeRepayMatchesViem(t *testing.T) {
	want := "20b76e81" + tuple +
		"0000000000000000000000000000000000000000000000000000000002faf080" +
		"0000000000000000000000000000000000000000000000000000000000000000" +
		selfWord +
		"0000000000000000000000000000000000000000000000000000000000000120" +
		"0000000000000000000000000000000000000000000000000000000000000000"
	got := hex.EncodeToString(EncodeRepay(market, big.NewInt(50_000000), self))
	if got != want {
		t.Fatalf("repay calldata differs from viem's\n got %s\nwant %s", got, want)
	}
}

// A full repay by SHARES: assets 0, the share count, the agent. This is the
// call that succeeded in simulation on 2026-09-24 against JohndoeAgent's real
// position after the same debt repaid by its rounded-up asset value reverted
// with an arithmetic underflow.
func TestEncodeRepaySharesPutsTheSharesInTheSharesSlot(t *testing.T) {
	shares, _ := new(big.Int).SetString("1963991696653", 10)
	want := "20b76e81" + tuple +
		"0000000000000000000000000000000000000000000000000000000000000000" + // assets
		"000000000000000000000000000000000000000000000000000001c94707050d" + // shares
		selfWord +
		"0000000000000000000000000000000000000000000000000000000000000120" +
		"0000000000000000000000000000000000000000000000000000000000000000"
	got := hex.EncodeToString(EncodeRepayShares(market, shares, self))
	if got != want {
		t.Fatalf("repay-by-shares calldata\n got %s\nwant %s", got, want)
	}
}

func TestEncodeWithdrawCollateralMatchesViem(t *testing.T) {
	want := "8720316d" + tuple +
		"00000000000000000000000000000000000000000000000006f05b59d3b20000" + // 0.5e18
		selfWord + selfWord // onBehalf and receiver: the agent, both
	got := hex.EncodeToString(EncodeWithdrawCollateral(market, new(big.Int).Div(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), big.NewInt(2)), self))
	if got != want {
		t.Fatalf("withdrawCollateral calldata differs from viem's\n got %s\nwant %s", got, want)
	}
}
