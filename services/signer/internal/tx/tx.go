// Package tx builds and signs EIP-1559 transactions.
//
// THE SIGNER NEVER ACCEPTS CALLDATA. It accepts a named intent and builds the
// calldata itself, here. That is the difference between an allowlist and a
// denylist, expressed in code rather than in a policy document: a caller cannot
// ask for a raw transfer because there is no way to say it. Validating
// attacker-supplied calldata would mean every future encoding trick is a bug
// waiting to be found; constructing it means the set of possible transactions
// is whatever this file can build, and nothing else.
package tx

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/arcana/signer/internal/keys"
)

// --- ABI encoding for the two shapes this service can build -----------------

const (
	selApprove          = "095ea7b3" // approve(address,uint256)
	selExactInputSingle = "04e45aaf" // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
)

func padAddress(a string) []byte {
	b, _ := hex.DecodeString(strings.TrimPrefix(strings.ToLower(a), "0x"))
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func padUint(v *big.Int) []byte {
	out := make([]byte, 32)
	b := v.Bytes()
	if len(b) > 32 {
		b = b[len(b)-32:]
	}
	copy(out[32-len(b):], b)
	return out
}

// EncodeApprove builds approve(spender, amount).
func EncodeApprove(spender string, amount *big.Int) []byte {
	sel, _ := hex.DecodeString(selApprove)
	out := append([]byte{}, sel...)
	out = append(out, padAddress(spender)...)
	out = append(out, padUint(amount)...)
	return out
}

// SwapParams is a Uniswap v3 exactInputSingle, restricted to what this service
// permits: the recipient is always the agent's own wallet, and there is no
// path variant, so a multi-hop route through an unapproved pool cannot be
// expressed.
type SwapParams struct {
	TokenIn   string
	TokenOut  string
	Fee       uint32
	Recipient string
	AmountIn  *big.Int
	MinOut    *big.Int
}

// EncodeExactInputSingle builds the swap calldata.
func EncodeExactInputSingle(p SwapParams) []byte {
	sel, _ := hex.DecodeString(selExactInputSingle)
	out := append([]byte{}, sel...)
	out = append(out, padAddress(p.TokenIn)...)
	out = append(out, padAddress(p.TokenOut)...)
	out = append(out, padUint(new(big.Int).SetUint64(uint64(p.Fee)))...)
	out = append(out, padAddress(p.Recipient)...)
	out = append(out, padUint(p.AmountIn)...)
	out = append(out, padUint(p.MinOut)...)
	out = append(out, padUint(big.NewInt(0))...) // sqrtPriceLimitX96: no limit
	return out
}

// --- RLP --------------------------------------------------------------------

func rlpBytes(b []byte) []byte {
	if len(b) == 1 && b[0] < 0x80 {
		return b
	}
	return append(rlpLen(len(b), 0x80), b...)
}

func rlpLen(n int, offset byte) []byte {
	if n < 56 {
		return []byte{offset + byte(n)}
	}
	lenBytes := big.NewInt(int64(n)).Bytes()
	return append([]byte{offset + 55 + byte(len(lenBytes))}, lenBytes...)
}

func rlpList(items ...[]byte) []byte {
	var payload []byte
	for _, it := range items {
		payload = append(payload, it...)
	}
	return append(rlpLen(len(payload), 0xc0), payload...)
}

// rlpUint encodes an integer as a minimal big-endian byte string. Zero is the
// empty string, not a zero byte — a distinction Ethereum consensus cares about.
func rlpUint(v *big.Int) []byte {
	if v == nil || v.Sign() == 0 {
		return rlpBytes(nil)
	}
	return rlpBytes(v.Bytes())
}

func rlpAddress(a string) []byte {
	b, _ := hex.DecodeString(strings.TrimPrefix(strings.ToLower(a), "0x"))
	return rlpBytes(b)
}

// --- transaction ------------------------------------------------------------

// Tx is an EIP-1559 transaction. `Value` is absent on purpose: every intent
// this service can build is an ERC-20 call, so native value is always zero, and
// a field that is always zero is a field that can one day be set by mistake.
type Tx struct {
	ChainID              *big.Int
	Nonce                uint64
	MaxPriorityFeePerGas *big.Int
	MaxFeePerGas         *big.Int
	Gas                  uint64
	To                   string
	Data                 []byte
}

func (t *Tx) unsignedFields() [][]byte {
	return [][]byte{
		rlpUint(t.ChainID),
		rlpUint(new(big.Int).SetUint64(t.Nonce)),
		rlpUint(t.MaxPriorityFeePerGas),
		rlpUint(t.MaxFeePerGas),
		rlpUint(new(big.Int).SetUint64(t.Gas)),
		rlpAddress(t.To),
		rlpUint(big.NewInt(0)), // value: always zero, see above
		rlpBytes(t.Data),
		rlpList(), // empty access list
	}
}

// SigningHash is keccak256(0x02 || rlp([...])).
func (t *Tx) SigningHash() []byte {
	payload := rlpList(t.unsignedFields()...)
	return keys.Keccak256([]byte{0x02}, payload)
}

// Signed returns the raw transaction, ready to broadcast — which this service
// does not do. Producing it and NOT sending it is the whole point of this
// phase: the path is proved before anything is at stake.
func (t *Tx) Signed(r, s [32]byte, v byte) string {
	fields := append(t.unsignedFields(),
		rlpUint(new(big.Int).SetUint64(uint64(v))),
		rlpBytes(trimLeadingZeros(r[:])),
		rlpBytes(trimLeadingZeros(s[:])),
	)
	raw := append([]byte{0x02}, rlpList(fields...)...)
	return "0x" + hex.EncodeToString(raw)
}

// Hash is the transaction hash the chain would give it.
func (t *Tx) Hash(r, s [32]byte, v byte) string {
	raw := t.Signed(r, s, v)
	b, _ := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	return "0x" + hex.EncodeToString(keys.Keccak256(b))
}

func trimLeadingZeros(b []byte) []byte {
	i := 0
	for i < len(b) && b[i] == 0 {
		i++
	}
	return b[i:]
}

// ParseHexAmount reads a decimal or 0x-hex amount, refusing anything else.
func ParseHexAmount(s string) (*big.Int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("amount is required")
	}
	base := 10
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		s, base = s[2:], 16
	}
	v, ok := new(big.Int).SetString(s, base)
	if !ok || v.Sign() < 0 {
		return nil, fmt.Errorf("amount %q is not a non-negative integer", s)
	}
	return v, nil
}
