package execution

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
)

// Naming slippage when it is slippage.
//
// WHY THIS EXISTS NOW. `min_out` is the only thing left that bounds the PRICE a
// trade fills at — the notional ceiling that used to bound its SIZE was removed
// on 2026-09-11, because how much of their own money an owner commits to one
// trade is trading style. That makes min_out load-bearing in a way it was not
// before, and a load-bearing check has to be legible when it fires.
//
// Before this, a swap stopped by its own slippage floor was recorded as:
//
//	status = reverted, note = "mined and reverted: gas was paid and no funds moved"
//
// which is true and says nothing. It reads identically to a token pausing, a
// pool draining, a bad allowance, or a bug in the calldata. An owner reading it
// cannot tell that the answer is "the price moved between the quote and the
// send, and your floor did its job" — and that is exactly the case where the
// system behaved correctly and should be able to say so.
//
// HOW THE REASON IS RECOVERED. A receipt carries a status bit and no reason. So
// after a revert the EXACT SAME CALLDATA is replayed as an eth_call, which costs
// nothing and makes the node execute it and return the revert payload. The pool
// has moved on by then, so the answer is "why would this revert now" rather than
// "why did it revert then" — close enough to name the cause, and the note says
// which of the two it is rather than implying the stronger one.

// Uniswap V3's SwapRouter reverts with these strings when the output floor is
// not met. Both are the same event from the two directions of the router.
var slippageMessages = []string{
	"too little received",
	"too much requested",
}

// SlippageRefusal is written to executions.refusal_code when a swap was stopped
// by its own min_out.
const SlippageRefusal = "slippage"

// explainRevert asks the chain why a swap would revert, and names slippage when
// that is the answer.
//
// It never fails the caller: a diagnosis that cannot be obtained leaves the
// original, truthful "mined and reverted" note alone rather than replacing it
// with a guess.
func (b *Broker) explainRevert(ctx context.Context, req Request, res *Result,
	tokenIn, tokenOut TokenCfg, poolFee uint32, amountIn, minOut *big.Int) {

	if res.MinOut == nil {
		return
	}
	data := EncodeExactInputSingle(tokenIn.Address, tokenOut.Address, poolFee,
		req.Wallet, amountIn, minOut)
	_, err := b.rpc.SimulateSwap(ctx, req.Wallet, b.cfg.Router(), data)
	if err == nil {
		// It succeeds now. That is itself the diagnosis: whatever stopped it has
		// passed, which is the shape of a price that moved and moved back.
		res.Note += " | replayed as a call afterwards and it would succeed now, so the " +
			"cause was transient — a price that moved between the quote and the send"
		return
	}

	reason := revertReason(err)
	low := strings.ToLower(reason)
	for _, m := range slippageMessages {
		if strings.Contains(low, m) {
			res.RefusalCode = SlippageRefusal
			res.Note = fmt.Sprintf(
				"stopped by its own slippage floor: the pool quoted %s and the transaction carried a "+
					"min_out of %s (%d bps below the quote), and the price moved past that between "+
					"the quote and the send. Replaying the same calldata now still reverts with %q. "+
					"Gas was paid and no funds moved, which is what the floor is for: the alternative "+
					"was filling at a worse price",
				bigOrDash(res.QuotedOut), bigOrDash(res.MinOut), b.SlippageBps, reason)
			return
		}
	}
	if reason != "" {
		res.Note += " | replayed as a call afterwards, the chain says: " + reason
	}
}

// revertReason pulls a human string out of a revert, whatever shape it arrives
// in: a plain message, or an ABI-encoded Error(string) payload.
func revertReason(err error) string {
	type dataErr interface{ Error() string }
	msg := err.Error()

	// Error(string) is selector 08c379a0, then offset, then length, then bytes.
	if i := strings.Index(msg, "0x08c379a0"); i >= 0 {
		body := msg[i+len("0x08c379a0"):]
		if j := strings.IndexAny(body, " )\n"); j >= 0 {
			body = body[:j]
		}
		if s := decodeErrorString(body); s != "" {
			return s
		}
	}
	var _ dataErr = err
	return strings.TrimSpace(msg)
}

func decodeErrorString(hexBody string) string {
	raw, err := hex.DecodeString(strings.TrimPrefix(hexBody, "0x"))
	if err != nil || len(raw) < 64 {
		return ""
	}
	length := new(big.Int).SetBytes(raw[32:64]).Int64()
	if length <= 0 || int64(len(raw)) < 64+length {
		return ""
	}
	return string(raw[64 : 64+length])
}

func bigOrDash(v *big.Int) string {
	if v == nil {
		return "-"
	}
	return v.String()
}
