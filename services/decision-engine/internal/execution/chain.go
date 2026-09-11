// Package execution turns a decision into a transaction, and a transaction
// back into a record of what happened.
//
// THE RULE THIS PACKAGE EXISTS FOR. Nothing here may write down what it
// expected. Every number that ends up in the `executions` table is read from
// the chain after the fact: the fill is a balance delta, the gas is from the
// receipt, the block is where it landed. The quote is kept too, but only so
// the two can be compared — it is never allowed to stand in for the fill.
//
// WHAT IS DELIBERATELY NOT HERE. No retries of a broadcast transaction. A
// swap that has been signed and sent is out in the world with a nonce attached
// to it; sending it again, or sending a replacement, is how one intent becomes
// two fills. When the wait expires the answer is "unresolved", which is a state
// this system can hold rather than a failure it has to resolve immediately.
package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// RPC is the smallest chain client this package needs: read balances, send a
// signed transaction, and ask what became of it.
type RPC struct {
	urls []string
	http *http.Client
}

func NewRPC(urls []string, timeout time.Duration) *RPC {
	return &RPC{urls: urls, http: &http.Client{Timeout: timeout}}
}

type rpcError struct {
	Message string `json:"message"`
	Data    string `json:"data"`
	Code    int    `json:"code"`
}

func (e *rpcError) Error() string {
	if e.Data != "" {
		return fmt.Sprintf("%s (data %s)", e.Message, e.Data)
	}
	return e.Message
}

// IsRevert reports whether the node refused because the CONTRACT said no,
// rather than because the call never got there. The distinction decides
// whether a retry against another endpoint could possibly help.
func (e *rpcError) IsRevert() bool {
	return strings.Contains(strings.ToLower(e.Message), "revert")
}

func (c *RPC) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	if err != nil {
		return nil, err
	}
	// EVERY endpoint failure is kept, not just the last one. The first version
	// reported only the final error, so a cycle that died because the primary
	// endpoint was refusing connections was reported as a timeout on the
	// secondary — sending whoever read it to look at the wrong host.
	var failures []string
	for _, u := range c.urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
		if err != nil {
			failures = append(failures, u+": "+err.Error())
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := c.http.Do(req)
		if err != nil {
			failures = append(failures, u+": "+err.Error())
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		var parsed struct {
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			failures = append(failures, u+": "+err.Error())
			continue
		}
		if parsed.Error != nil {
			// A revert is the contract answering. Every honest endpoint returns
			// the same one, so asking the rest only turns a deterministic fact
			// into what looks like a network problem.
			if parsed.Error.IsRevert() {
				return nil, parsed.Error
			}
			failures = append(failures, u+": "+parsed.Error.Error())
			continue
		}
		return parsed.Result, nil
	}
	return nil, fmt.Errorf("%s: every RPC endpoint failed: %s", method, strings.Join(failures, " | "))
}

func (c *RPC) hexString(ctx context.Context, method string, params any) (string, error) {
	raw, err := c.call(ctx, method, params)
	if err != nil {
		return "", err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", fmt.Errorf("%s: unexpected result %s", method, string(raw))
	}
	return s, nil
}

func hexToBig(s string) (*big.Int, error) {
	v, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("not a hex quantity: %q", s)
	}
	return v, nil
}

// NativeBalance is the agent's gas balance. A wallet holding tokens and no gas
// signs perfectly valid transactions that cannot be mined, so this is checked
// before anything is signed rather than discovered afterwards.
func (c *RPC) NativeBalance(ctx context.Context, addr string) (*big.Int, error) {
	s, err := c.hexString(ctx, "eth_getBalance", []any{addr, "latest"})
	if err != nil {
		return nil, err
	}
	return hexToBig(s)
}

func (c *RPC) Nonce(ctx context.Context, addr string) (uint64, error) {
	s, err := c.hexString(ctx, "eth_getTransactionCount", []any{addr, "pending"})
	if err != nil {
		return 0, err
	}
	v, err := hexToBig(s)
	if err != nil {
		return 0, err
	}
	return v.Uint64(), nil
}

func padAddr(a string) string {
	return strings.Repeat("0", 24) + strings.ToLower(strings.TrimPrefix(a, "0x"))
}

func padUint(v *big.Int) string {
	h := v.Text(16)
	return strings.Repeat("0", 64-len(h)) + h
}

// TokenBalance reads balanceOf(owner).
func (c *RPC) TokenBalance(ctx context.Context, token, owner string) (*big.Int, error) {
	data := "0x70a08231" + padAddr(owner)
	s, err := c.hexString(ctx, "eth_call", []any{map[string]string{"to": token, "data": data}, "latest"})
	if err != nil {
		return nil, err
	}
	return hexToBig(s)
}

// Allowance reads allowance(owner, spender).
func (c *RPC) Allowance(ctx context.Context, token, owner, spender string) (*big.Int, error) {
	data := "0xdd62ed3e" + padAddr(owner) + padAddr(spender)
	s, err := c.hexString(ctx, "eth_call", []any{map[string]string{"to": token, "data": data}, "latest"})
	if err != nil {
		return nil, err
	}
	return hexToBig(s)
}

// SimulateSwap runs the EXACT calldata the signer will build, against live
// state, and returns what it would fill.
//
// This is the quote. It is recorded next to the fill so the two can disagree
// on the record rather than in somebody's memory of what they expected.
func (c *RPC) SimulateSwap(ctx context.Context, from, router, data string) (*big.Int, error) {
	s, err := c.hexString(ctx, "eth_call", []any{
		map[string]string{"from": from, "to": router, "data": data}, "latest"})
	if err != nil {
		return nil, err
	}
	return hexToBig(s)
}

func (c *RPC) SendRaw(ctx context.Context, raw string) (string, error) {
	return c.hexString(ctx, "eth_sendRawTransaction", []any{raw})
}

// Receipt is the part of a transaction receipt this package acts on.
type Receipt struct {
	Status      string `json:"status"`
	BlockNumber string `json:"blockNumber"`
	GasUsed     string `json:"gasUsed"`
	EffGasPrice string `json:"effectiveGasPrice"`
}

// Mined reports true when the receipt is the transaction's final answer.
func (r *Receipt) Mined() bool { return r != nil && r.BlockNumber != "" }

// Succeeded is status 0x1. A reverted transaction HAS a receipt, a block and a
// gas bill — treating "I got a receipt" as success is the mistake this exists
// to make impossible.
func (r *Receipt) Succeeded() bool { return r != nil && r.Status == "0x1" }

// WaitReceipt polls until the transaction is mined or the budget runs out.
//
// It returns (nil, nil) when the wait expires WITHOUT an error: not mined yet
// is a real answer, and the caller records it as unresolved rather than
// deciding on the agent's behalf what probably happened.
func (c *RPC) WaitReceipt(ctx context.Context, hash string, budget time.Duration, every time.Duration) (*Receipt, error) {
	deadline := time.Now().Add(budget)
	for {
		raw, err := c.call(ctx, "eth_getTransactionReceipt", []any{hash})
		if err != nil {
			return nil, err
		}
		if len(raw) > 0 && string(raw) != "null" {
			var r Receipt
			if err := json.Unmarshal(raw, &r); err != nil {
				return nil, err
			}
			if r.Mined() {
				return &r, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(every):
		}
	}
}
