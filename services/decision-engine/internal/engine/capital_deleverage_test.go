package engine

import (
	"math"
	"testing"

	"github.com/arcana/decision-engine/internal/capital"
)

var dm = capital.Mandate{MinHealthFactor: 2, MaxBorrowRateBps: 800, LiquidityTriggerUSDG: 50, MaxBorrowUSDG: 150}

// 1 NVDA at a worst price of 150, LLTV 62.5%, 60 owed: HF = 1.5625, under 2.
// Target debt = 150*0.625/(2*1.1) = 42.61, so 17.39 must go.
func under() capital.State {
	return capital.State{CollateralQty: 1, DebtUSDG: 60, LLTV: 0.625, OraclePrice: 150, PoolPrice: 150}
}

func TestDeleverageRepaysFromTheWalletFirst(t *testing.T) {
	s := under()
	s.WalletUSDG, s.WalletCollateral = 100, 5
	p := PlanDeleverage(dm, s)
	if p.Kind != "repay" || math.Abs(p.Amount-(60-150*0.625/2.2)) > 1e-9 {
		t.Fatalf("want a repay of the shortfall from the wallet, got %+v", p)
	}
}

func TestDeleverageSellsWalletCollateralNext(t *testing.T) {
	s := under()
	s.WalletCollateral = 5
	p := PlanDeleverage(dm, s)
	need := 60 - 150*0.625/2.2
	if p.Kind != "sell" || math.Abs(p.Amount-need/150*1.02) > 1e-9 {
		t.Fatalf("want a sell of the wallet's collateral, got %+v", p)
	}
}

func TestDeleverageWithdrawsWithinTheSafetyLine(t *testing.T) {
	s := under()
	p := PlanDeleverage(dm, s)
	if p.Kind != "withdraw" {
		t.Fatalf("want a withdrawal, got %+v", p)
	}
	after := (s.CollateralQty - p.Amount) * 150 * 0.625 / s.DebtUSDG
	if after < withdrawSafety-1e-9 {
		t.Fatalf("the withdrawal takes the health factor to %.4f, under the %.2f safety line", after, withdrawSafety)
	}
}

func TestDeleverageStuckWhenNothingCanMove(t *testing.T) {
	s := under()
	s.DebtUSDG = 88 // HF 1.065: barely any room over the 1.05 line
	s.CollateralQty = 1
	p := PlanDeleverage(dm, s)
	if p.Kind == "withdraw" {
		after := (s.CollateralQty - p.Amount) * 150 * 0.625 / s.DebtUSDG
		if after < withdrawSafety-1e-9 {
			t.Fatalf("withdrawal under the safety line: %.4f", after)
		}
	}
	s.DebtUSDG = 92 // HF 1.019: under the line already
	if p := PlanDeleverage(dm, s); p.Kind != "" || p.Why == "" {
		t.Fatalf("with no room at all the plan must do nothing and say why, got %+v", p)
	}
}

func TestDeleverageUsesTheWorsePrice(t *testing.T) {
	s := under()
	s.OraclePrice, s.PoolPrice = 300, 150 // the oracle says fine; the pool says not
	s.WalletUSDG = 100
	if p := PlanDeleverage(dm, s); p.Kind != "repay" {
		t.Fatalf("the pool price puts this under the floor and nothing was planned: %+v", p)
	}
}

func TestNothingAboveTheFloor(t *testing.T) {
	s := under()
	s.DebtUSDG = 20 // HF 4.69
	s.WalletUSDG = 100
	if p := PlanDeleverage(dm, s); p.Kind != "" {
		t.Fatalf("a healthy position was deleveraged: %+v", p)
	}
}
