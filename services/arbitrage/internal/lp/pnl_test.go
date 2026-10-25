package lp

import (
	"math/big"
	"testing"
)

func TestFeeOnlyCollect(t *testing.T) {
	cases := []struct {
		name    string
		intents []string
		want    bool
	}{
		{"a harvest is a collect alone", []string{"lp_collect"}, true},
		{"empty is not a harvest", nil, false},
		{"a collect after a decrease returns principal too", []string{"lp_decrease", "lp_collect"}, false},
		{"a close collects then burns", []string{"lp_collect", "lp_burn"}, false},
		{"a mint is not a harvest", []string{"lp_mint"}, false},
		{"case and spaces do not change the meaning", []string{" LP_Collect "}, true},
	}
	for _, c := range cases {
		if got := FeeOnlyCollect(c.intents); got != c.want {
			t.Errorf("%s: FeeOnlyCollect(%v) = %v, want %v", c.name, c.intents, got, c.want)
		}
	}
}

func TestHumanKeepsSmallSides(t *testing.T) {
	// 4,013,404,123,064 wei of an 18-decimal token is 0.000004013404123064.
	raw, _ := new(big.Int).SetString("4013404123064", 10)
	got := Human(raw, 18)
	want := 0.000004013404123064
	if diff := got - want; diff > 1e-18 || diff < -1e-18 {
		t.Errorf("Human(4013404123064, 18) = %v, want %v", got, want)
	}
	// 2,439 raw USDG (6 decimals) is 0.002439.
	usdg, _ := new(big.Int).SetString("2439", 10)
	if got := Human(usdg, 6); got != 0.002439 {
		t.Errorf("Human(2439, 6) = %v, want 0.002439", got)
	}
}

func TestValueUSDAddsBothSides(t *testing.T) {
	a0, _ := new(big.Int).SetString("2439", 10)          // USDG, 6 decimals
	a1, _ := new(big.Int).SetString("4013404123064", 10) // QQQ, 18 decimals
	got := ValueUSD(a0, a1, 6, 18, 1, 700)
	want := 0.002439 + 0.000004013404123064*700
	if diff := got - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("ValueUSD = %v, want %v", got, want)
	}
	if got := ValueUSD(nil, nil, 6, 18, 1, 700); got != 0 {
		t.Errorf("ValueUSD(nil, nil) = %v, want 0", got)
	}
}

func TestGasWeiNeedsBothFactors(t *testing.T) {
	used := big.NewInt(257882)
	price := big.NewInt(20784000)
	if got := GasWei(used, price); got == nil || got.String() != "5359756848000" {
		t.Errorf("GasWei = %v, want 5359756848000", got)
	}
	if got := GasWei(used, nil); got != nil {
		t.Errorf("GasWei with no price = %v, want nil (unpriced is not free)", got)
	}
	if got := GasWei(nil, price); got != nil {
		t.Errorf("GasWei with no gasUsed = %v, want nil", got)
	}
}

func TestWeiETH(t *testing.T) {
	wei, _ := new(big.Int).SetString("10431900000000", 10)
	got := WeiETH(wei)
	if diff := got - 0.0000104319; diff > 1e-15 || diff < -1e-15 {
		t.Errorf("WeiETH = %v, want 0.0000104319", got)
	}
}
