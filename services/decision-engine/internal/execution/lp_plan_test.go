package execution

import (
	"encoding/json"
	"testing"
)

const (
	lpNPM     = "0x73991a25c818bf1f1128deaab1492d45638de0d3"
	lpWallet  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	lpNVDA    = "0x1111111111111111111111111111111111111111"
	lpUSDG    = "0x5fc5360d0400a0fd4f9a3e0e1e2f0a1a2b3c4d5e"
	lpAgent   = "agent-1"
	lpTokenID = "7"
	lpDeadline = int64(1800000000)
)

func lpDetail() json.RawMessage {
	return json.RawMessage(`{"intents":["lp_collect","lp_decrease","lp_burn","lp_mint"],
		"plan":{"tick_lower":-600,"tick_upper":600,"amount0_desired":"100","amount1_desired":"200","amount0_min":"99","amount1_min":"198"},
		"slippage_bps":50,"current_tick":5000}`)
}

func lpProposal(rec string) LPProposal {
	return LPProposal{ID: 3, TokenID: lpTokenID, AgentID: lpAgent, Recommendation: rec, Detail: lpDetail()}
}

func lpRow() LPRegistryRow {
	return LPRegistryRow{TokenID: lpTokenID, AgentID: lpAgent, Wallet: lpWallet, Status: "open"}
}

func lpPosition(liquidity string, inRange bool) *LPPositionRead {
	return &LPPositionRead{
		TokenID: lpTokenID, Owner: lpWallet, Token0: lpNVDA, Token1: lpUSDG, Fee: 500,
		TickLower: -1000, TickUpper: 1000, Liquidity: liquidity,
		CurrentTick: 5000, InRange: inRange, Amount0: "1000", Amount1: "2000",
	}
}

func names(in []LPIntent) []string {
	out := make([]string, 0, len(in))
	for _, i := range in {
		out = append(out, i.Intent)
	}
	return out
}

func TestPlanRebalanceAssemblesTheSequence(t *testing.T) {
	plan := PlanLPAction(lpProposal("rebalance"), lpRow(), lpPosition("1000000", false), lpNPM, lpDeadline)
	if plan.Refusal != "" {
		t.Fatalf("refused: %s", plan.Refusal)
	}
	got := names(plan.Intents)
	want := []string{"lp_collect", "lp_decrease", "lp_burn", "lp_mint"}
	if len(got) != len(want) {
		t.Fatalf("intents: got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("intent order: got %v want %v", got, want)
		}
	}

	collect := plan.Intents[0].Body
	if collect["amount"] != "0" || collect["router"] != lpNPM || collect["token_id"] != lpTokenID {
		t.Fatalf("collect body: %v", collect)
	}
	decrease := plan.Intents[1].Body
	if decrease["liquidity"] != "1000000" {
		t.Fatalf("decrease must take the whole liquidity: %v", decrease)
	}
	// floor(1000 * 9950/10000) = 995, floor(2000 * 9950/10000) = 1990.
	if decrease["amount0_min"] != "995" || decrease["amount1_min"] != "1990" {
		t.Fatalf("decrease floors: %v", decrease)
	}
	if decrease["deadline"] != "1800000000" {
		t.Fatalf("decrease deadline: %v", decrease)
	}
	mint := plan.Intents[3].Body
	if mint["token_in"] != lpNVDA || mint["token_out"] != lpUSDG {
		t.Fatalf("mint pair: %v", mint)
	}
	if fee, ok := mint["fee"].(uint32); !ok || fee != 500 {
		t.Fatalf("mint fee: %v", mint)
	}
	if mint["tick_lower"] != int32(-600) || mint["tick_upper"] != int32(600) {
		t.Fatalf("mint range: %v", mint)
	}
	if mint["amount0_desired"] != "100" || mint["amount1_min"] != "198" {
		t.Fatalf("mint amounts must come from the plan: %v", mint)
	}
	if mint["deadline"] != "1800000000" {
		t.Fatalf("mint deadline: %v", mint)
	}
}

func TestPlanEmptyAssemblesCollectAndBurn(t *testing.T) {
	plan := PlanLPAction(lpProposal("empty"), lpRow(), lpPosition("0", true), lpNPM, lpDeadline)
	if plan.Refusal != "" {
		t.Fatalf("refused: %s", plan.Refusal)
	}
	if got := names(plan.Intents); len(got) != 2 || got[0] != "lp_collect" || got[1] != "lp_burn" {
		t.Fatalf("close sequence: %v", got)
	}
}

func TestPlanRefusesOwnerMismatch(t *testing.T) {
	pos := lpPosition("1000000", false)
	pos.Owner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	plan := PlanLPAction(lpProposal("rebalance"), lpRow(), pos, lpNPM, lpDeadline)
	if plan.Refusal == "" || len(plan.Intents) != 0 {
		t.Fatalf("a foreign owner must refuse: %+v", plan)
	}
}

func TestPlanRefusesStaleRebalance(t *testing.T) {
	// The proposal says rebalance; the chain says the price is back inside the
	// position's own range. The verdict this plan would act on no longer holds.
	plan := PlanLPAction(lpProposal("rebalance"), lpRow(), lpPosition("1000000", true), lpNPM, lpDeadline)
	if plan.Refusal == "" || len(plan.Intents) != 0 {
		t.Fatalf("back-in-range must refuse: %+v", plan)
	}
}

func TestPlanRefusesVerdictThatContradictsTheChain(t *testing.T) {
	// "rebalance" with no liquidity is a close, and "empty" with liquidity is a
	// rebalance. Acting on either would send the wrong sequence.
	a := PlanLPAction(lpProposal("rebalance"), lpRow(), lpPosition("0", false), lpNPM, lpDeadline)
	if a.Refusal == "" {
		t.Fatalf("rebalance with zero liquidity must refuse: %+v", a)
	}
	b := PlanLPAction(lpProposal("empty"), lpRow(), lpPosition("1000000", true), lpNPM, lpDeadline)
	if b.Refusal == "" {
		t.Fatalf("empty with liquidity must refuse: %+v", b)
	}
}

func TestPlanRefusesMissingPlanAndBadInputs(t *testing.T) {
	noPlan := lpProposal("rebalance")
	noPlan.Detail = json.RawMessage(`{"slippage_bps":50}`)
	if p := PlanLPAction(noPlan, lpRow(), lpPosition("1000000", false), lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("missing plan must refuse: %+v", p)
	}

	noSlip := lpProposal("rebalance")
	noSlip.Detail = json.RawMessage(`{"plan":{"tick_lower":-600,"tick_upper":600,"amount0_desired":"1","amount1_desired":"1","amount0_min":"1","amount1_min":"1"}}`)
	if p := PlanLPAction(noSlip, lpRow(), lpPosition("1000000", false), lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("missing slippage must refuse: %+v", p)
	}

	if p := PlanLPAction(lpProposal("rebalance"), lpRow(), lpPosition("1000000", false), lpNPM, 0); p.Refusal == "" {
		t.Fatalf("missing deadline must refuse: %+v", p)
	}

	bad := lpPosition("1000000", false)
	bad.Amount0 = "not-a-number"
	if p := PlanLPAction(lpProposal("rebalance"), lpRow(), bad, lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("unparseable amounts must refuse: %+v", p)
	}

	if p := PlanLPAction(lpProposal("rebalance"), LPRegistryRow{TokenID: "other"}, lpPosition("1000000", false), lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("a registry mismatch must refuse: %+v", p)
	}
	if p := PlanLPAction(lpProposal("rebalance"), lpRow(), nil, lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("an unreadable position must refuse: %+v", p)
	}
	if p := PlanLPAction(lpProposal("rebalance"), lpRow(), lpPosition("1000000", false), "", lpDeadline); p.Refusal == "" {
		t.Fatalf("a missing position manager must refuse: %+v", p)
	}
	if p := PlanLPAction(lpProposal("sideways"), lpRow(), lpPosition("1000000", false), lpNPM, lpDeadline); p.Refusal == "" {
		t.Fatalf("an unknown recommendation must refuse: %+v", p)
	}
}
