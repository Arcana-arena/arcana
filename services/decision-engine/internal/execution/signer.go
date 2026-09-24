package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
)

// SignerClient talks to the one service that can move money.
//
// It deliberately has no fallback. If the signer is unreachable, this package
// records a refusal and the agent holds — it does NOT sign locally, hold a key,
// or retry against anything else. The whole point of the signer being a
// separate process under a separate Linux user is that no other component can
// produce a signature, and a client that worked around an outage would quietly
// undo that.
type SignerClient struct {
	base string
	key  string
	http *http.Client
}

func NewSignerClient(base, internalKey string, c *http.Client) *SignerClient {
	return &SignerClient{base: base, key: internalKey, http: c}
}

type SignRequest struct {
	Intent    string `json:"intent"`
	AgentID   string `json:"agent_id"`
	MarketID  string `json:"market_id,omitempty"` // lending intents only
	RepayAll  bool   `json:"repay_all,omitempty"` // lending_repay: the whole debt, by shares
	TokenIn   string `json:"token_in"`
	TokenOut  string `json:"token_out,omitempty"`
	Router    string `json:"router"`
	Amount    string `json:"amount"`
	MinOut    string `json:"min_out,omitempty"`
	Nonce     uint64 `json:"nonce"`
	Gas       uint64 `json:"gas,omitempty"`
	MaxFeeWei string `json:"max_fee_wei,omitempty"`
	TipWei    string `json:"tip_wei,omitempty"`
}

type SignResponse struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Raw     string `json:"raw"`
	TxHash  string `json:"tx_hash"`
	ChainID int64  `json:"chain_id"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Refusal is the signer declining, which is a normal outcome rather than a
// fault. It carries the machine-readable code so the record can say WHICH no.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

// Fault is the signer answering something this client cannot act on.
//
// IT IS NOT A REFUSAL, AND THE DIFFERENCE IS THE WHOLE REASON IT IS A SEPARATE
// TYPE. A Refusal means the signer looked at the intent and said no — a normal
// outcome, recorded as `refused`, and the operator's next step is to read which
// policy declined it. A Fault means the signer never got far enough to decide,
// or answered in a shape this client does not understand: a reverse proxy
// returning 503 in front of it, a truncated body, a version mismatch. Recording
// that as `refused` would put a decision in the record that nobody made, and
// would send an operator looking through signer policy for a rule that was
// never consulted.
//
// So it carries a code — which is what was missing, and why every one of these
// used to arrive as an untyped sentence — while leaving the execution status at
// `blocked`: nothing was signed and nothing was sent, which is true in both
// cases and is all this client actually knows.
type Fault struct {
	Code    string
	Status  int
	Message string
}

func (f *Fault) Error() string { return f.Code + ": " + f.Message }

// truncate bounds the BODY quoted inside a fault message.
//
// Safe here, and only because the code has already been lifted out into its own
// field before this is called. Truncating a response that is still the only
// carrier of its own code is a different thing entirely — the code survives or
// not depending on how long the message happened to be, which is luck rather
// than design. The cadence and scheduler workers had exactly that.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (s *SignerClient) Sign(ctx context.Context, req SignRequest) (*SignResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/internal/v1/signer/sign", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("X-Internal-Key", s.key)
	res, err := s.http.Do(hr)
	if err != nil {
		return nil, fmt.Errorf("signer unreachable: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out SignResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &Fault{
			Code:   "signer_unreadable_response",
			Status: res.StatusCode,
			Message: fmt.Sprintf("the signer answered HTTP %d with a body this client could not parse: %q",
				res.StatusCode, truncate(string(raw), 200)),
		}
	}
	if out.Error != nil {
		return nil, &Refusal{Code: out.Error.Code, Message: out.Error.Message}
	}
	// A NON-200 THAT NAMED NOTHING. The signer's own refuse() always sets
	// `error`, so reaching here means the answer did not come from the signer's
	// handler at all — a proxy, a gateway, a crash before the body was written.
	// Saying so is the point: an operator who sees this must look at the
	// transport, and the old bare string sent them to the policy instead.
	if res.StatusCode != http.StatusOK {
		return nil, &Fault{
			Code:   "signer_unexpected_status",
			Status: res.StatusCode,
			Message: fmt.Sprintf("the signer answered HTTP %d with no error code, which its own handler "+
				"never does — the answer did not come from the signer itself. Body: %q",
				res.StatusCode, truncate(string(raw), 200)),
		}
	}
	if out.Raw == "" {
		return nil, fmt.Errorf("signer returned no signed transaction")
	}
	return &out, nil
}

// EncodeExactInputSingle builds the SAME calldata the signer builds, so the
// simulation is of the transaction that will actually be sent.
//
// WHY IT IS DUPLICATED HERE rather than asked for. The signer signs; it does
// not simulate, and giving it a dry-run mode would mean the one process that
// can move money grows a second code path whose whole purpose is to not move
// money. Encoding is a pure function of five values, and swap-verify checks
// this function against what the signer produced for the same inputs — so a
// divergence is caught by a test rather than by a trade.
func EncodeExactInputSingle(tokenIn, tokenOut string, fee uint32, recipient string, amountIn, minOut *big.Int) string {
	feeBig := new(big.Int).SetUint64(uint64(fee))
	return "0x04e45aaf" +
		padAddr(tokenIn) +
		padAddr(tokenOut) +
		padUint(feeBig) +
		padAddr(recipient) +
		padUint(amountIn) +
		padUint(minOut) +
		padUint(big.NewInt(0)) // sqrtPriceLimitX96: no limit; min_out is the protection
}
