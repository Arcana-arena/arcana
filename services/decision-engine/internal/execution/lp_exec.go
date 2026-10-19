package execution

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// LP execution: sign one intent, broadcast it, read its receipt — in order,
// stopping at the first outcome that is not a success.
//
// THE RULES ARE THE MONEY PATH'S RULES, not new ones:
//
//   - The signer builds the transaction from a NAMED INTENT; this package never
//     sees a key and never constructs calldata.
//   - The gas reserve is checked before every signature, against the same
//     maxFee × gasLimit × 2 the swap path uses. A wallet that cannot pay is
//     blocked, not attempted.
//   - The receipt is the answer, not the broadcast: a reverted transaction has
//     a hash, a block and a gas bill and moved nothing.
//   - A broadcast that cannot be confirmed is UNRESOLVED — never retried, never
//     replaced. The hash is recorded at broadcast time, before the wait, so a
//     process that dies mid-wait leaves the transaction findable.
//   - The sequence stops at the first refusal, revert, unresolved receipt or
//     fault. Later steps are built on the earlier ones (burn requires the
//     decrease's liquidity to be gone), so continuing past a failure is how a
//     half-executed position happens.

// LPStepResult is one intent's outcome. The same step is recorded twice: once
// after the broadcast ("broadcast", with the hash) and once when the receipt
// arrives — the record is durable before the wait, so a crash cannot lose a
// transaction that is already on the wire.
type LPStepResult struct {
	Step    int    `json:"step"`
	Intent  string `json:"intent"`
	Status  string `json:"status"` // broadcast|mined|reverted|unresolved|refused|blocked|fault
	TxHash  string `json:"tx_hash,omitempty"`
	GasUsed string `json:"gas_used,omitempty"`
	Error   string `json:"error,omitempty"`
}

// LPExecResult is one action's whole outcome.
type LPExecResult struct {
	ActionID int64          `json:"action_id"`
	TokenID  string         `json:"token_id"`
	AgentID  string         `json:"agent_id"`
	Status   string         `json:"status"` // executed|failed
	Steps    []LPStepResult `json:"steps"`
	Error    string         `json:"error,omitempty"`
}

// lpGasLimit returns the gas limit for one LP shape. Per shape rather than one
// number because they differ by several hundred thousand: a mint with a fresh
// position is the expensive one, a burn of an empty position the cheapest. An
// over-generous limit reserves more gas than the wallet may hold; an
// under-generous one burns the reserve and reverts.
func lpGasLimit(intent string) uint64 {
	switch intent {
	case "lp_mint":
		return 700_000
	case "lp_decrease":
		return 350_000
	case "lp_collect":
		return 250_000
	case "lp_burn":
		return 150_000
	default:
		return 300_000
	}
}

// ExecuteLPPlan runs an assembled plan through the signer and the chain.
//
// record, when non-nil, is called for every state change of every step — the
// caller persists it (upsert by action and step). Errors of the record are the
// caller's business; they do not stop the chain work, because a database that
// cannot be written is not a reason to leave a signed transaction unsent.
func (b *Broker) ExecuteLPPlan(ctx context.Context, agentID, wallet string, plan LPActionPlan, record func(LPStepResult)) *LPExecResult {
	res := &LPExecResult{
		ActionID: plan.ActionID,
		TokenID:  plan.TokenID,
		AgentID:  agentID,
		Status:   "failed",
		Steps:    []LPStepResult{},
	}
	// One entry per step, updated in place: the broadcast emit and the receipt
	// emit describe the SAME step, and a summary that lists both would read as
	// eight intents when four were sent. The callback still fires on every
	// change, because the record has to survive a crash between them.
	at := map[int]int{}
	emit := func(sr LPStepResult) {
		if i, ok := at[sr.Step]; ok {
			res.Steps[i] = sr
		} else {
			at[sr.Step] = len(res.Steps)
			res.Steps = append(res.Steps, sr)
		}
		if record != nil {
			record(sr)
		}
	}
	fail := func(sr LPStepResult) *LPExecResult {
		emit(sr)
		res.Error = sr.Error
		return res
	}
	if len(plan.Intents) == 0 {
		res.Error = "the plan carries no intents"
		return res
	}

	for i, in := range plan.Intents {
		sr := LPStepResult{Step: i + 1, Intent: in.Intent}

		// The signer request is the SAME body the planner printed: marshalling
		// the map into SignRequest means the printed plan and the signed
		// transaction cannot describe different things.
		raw, err := json.Marshal(in.Body)
		if err != nil {
			sr.Status, sr.Error = "fault", "encode intent: "+err.Error()
			return fail(sr)
		}
		var req SignRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			sr.Status, sr.Error = "fault", "intent does not map to a signer request: "+err.Error()
			return fail(sr)
		}
		req.Intent = in.Intent
		req.AgentID = agentID
		req.Gas = lpGasLimit(in.Intent)
		req.MaxFeeWei = b.MaxFeeWei.String()
		req.TipWei = b.TipWei.String()

		need := new(big.Int).Mul(b.MaxFeeWei, new(big.Int).SetUint64(req.Gas))
		need.Mul(need, big.NewInt(2))
		bal, err := b.rpc.NativeBalance(ctx, wallet)
		if err != nil {
			sr.Status, sr.Error = "fault", "read gas balance: "+err.Error()
			return fail(sr)
		}
		if bal.Cmp(need) < 0 {
			sr.Status = "blocked"
			sr.Error = fmt.Sprintf("native balance %s is below the gas reserve %s for %s", bal, need, in.Intent)
			return fail(sr)
		}

		nonce, err := b.rpc.Nonce(ctx, wallet)
		if err != nil {
			sr.Status, sr.Error = "fault", "read nonce: "+err.Error()
			return fail(sr)
		}
		req.Nonce = nonce

		signed, err := b.signer.Sign(ctx, req)
		if err != nil {
			var ref *Refusal
			if errors.As(err, &ref) {
				sr.Status = "refused"
			} else {
				sr.Status = "fault"
			}
			sr.Error = err.Error()
			return fail(sr)
		}
		if signed == nil || signed.Raw == "" {
			sr.Status, sr.Error = "fault", "the signer answered without a signed transaction"
			return fail(sr)
		}

		hash, err := b.rpc.SendRaw(ctx, signed.Raw)
		if err != nil {
			sr.Status, sr.Error = "fault", "broadcast: "+err.Error()
			return fail(sr)
		}
		sr.TxHash = hash
		sr.Status = "broadcast"
		emit(sr)

		// The receipt wait outlives a cancelled caller on purpose: the
		// transaction is already on the wire, and abandoning the wait would
		// leave the record saying "broadcast" while the chain moves on.
		rctx := context.WithoutCancel(ctx)
		rcpt, err := b.rpc.WaitReceipt(rctx, hash, b.ReceiptWait, b.PollEvery)
		if err != nil {
			sr.Status = "unresolved"
			sr.Error = "receipt unavailable: " + err.Error()
			return fail(sr)
		}
		if rcpt == nil {
			sr.Status = "unresolved"
			sr.Error = fmt.Sprintf("not mined within %s; the hash is recorded and must be checked, not replaced", b.ReceiptWait)
			return fail(sr)
		}
		if !rcpt.Succeeded() {
			sr.Status = "reverted"
			sr.Error = "receipt status " + rcpt.Status + " (gas spent, nothing moved)"
			return fail(sr)
		}
		sr.Status = "mined"
		sr.GasUsed = rcpt.GasUsed
		emit(sr)
	}

	res.Status = "executed"
	return res
}

// LPPlanDeadline is how long an armed run's mint/decrease deadline lasts from
// the moment the bodies are assembled. Bounded on purpose: a transaction that
// waited longer than this for a block should fail, not execute against a price
// nobody is looking at any more.
func LPPlanDeadline(now time.Time) int64 { return now.Add(15 * time.Minute).Unix() }
