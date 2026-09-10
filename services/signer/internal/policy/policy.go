// Package policy decides what the signer is permitted to build.
//
// AN ALLOWLIST, NOT A DENYLIST. Every address in a transaction — the contract
// called, the tokens involved, the recipient — must appear in a reviewed,
// committed file. An address that is absent is refused, not because a rule
// forbids it but because nothing permits it. That distinction is the whole
// design: a denylist has to anticipate what an attacker will try, and an
// allowlist does not.
//
// ENFORCED HERE RATHER THAN AT THE CALLER. Every one of these checks also
// exists, or will exist, in the decision engine's policy layer. They are
// repeated at the signer because the signer is the last door before the chain,
// and a limit that lives only one layer up is a limit that any future caller —
// a migration script, an operator tool, a new endpoint someone adds in a hurry
// — can bypass by simply not knowing about it. The caller decides what it
// wants; the signer decides what is possible.
package policy

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
)

type Token struct {
	Symbol   string `json:"symbol"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
	Pool     string `json:"pool"`
	PoolFee  uint32 `json:"pool_fee"`
}

type Limits struct {
	MaxTradeNotionalUSD       float64 `json:"max_trade_notional_usd"`
	MaxApproveMultipleOfTrade float64 `json:"max_approve_multiple_of_trade"`
	MaxSignaturesPerDay       int     `json:"max_signatures_per_agent_per_day"`
}

type Allowlist struct {
	ChainID    int64   `json:"chain_id"`
	ReviewedAt string  `json:"reviewed_at"`
	QuoteToken Token   `json:"quote_token"`
	Routers    []string `json:"routers"`
	Tokens     []Token `json:"tokens"`
	Limits     Limits  `json:"limits"`

	byToken  map[string]Token
	byRouter map[string]bool
}

func Load(path string) (*Allowlist, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("allowlist: %w", err)
	}
	var a Allowlist
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("allowlist: %w", err)
	}
	if a.ChainID == 0 {
		return nil, fmt.Errorf("allowlist: chain_id is required — a transaction signed for the wrong chain is replayable on it")
	}
	a.byToken = map[string]Token{}
	for _, t := range a.Tokens {
		a.byToken[norm(t.Address)] = t
	}
	a.byToken[norm(a.QuoteToken.Address)] = a.QuoteToken
	a.byRouter = map[string]bool{}
	for _, r := range a.Routers {
		a.byRouter[norm(r)] = true
	}
	return &a, nil
}

func norm(a string) string { return strings.ToLower(strings.TrimSpace(a)) }

// Refusal is a rejection with a machine-readable reason. Every path that says
// no says WHICH no, because "signing refused" alone sends whoever reads the
// journal looking in the wrong place.
type Refusal struct {
	Code   string
	Detail string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Detail }

func refuse(code, format string, args ...any) *Refusal {
	return &Refusal{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// Reason codes. Each names a distinct thing that was wrong.
const (
	CodeUnknownIntent  = "unknown_intent"
	CodeTokenNotListed = "token_not_allowlisted"
	CodeRouterNotListed = "router_not_allowlisted"
	CodeNoRouters      = "no_router_configured"
	CodeRecipientNotSelf = "recipient_not_agent_wallet"
	CodeAmountOverCap  = "amount_over_cap"
	CodeDailyCap       = "daily_signature_cap"
	CodeSameToken      = "token_in_equals_token_out"
	CodeWalletBlocked  = "wallet_blocked"
	CodeTokenPaused    = "token_paused"
	CodeChainUnverifiable = "chain_state_unverifiable"
	CodeChainMismatch  = "chain_id_mismatch"
)

// Token returns an allowlisted token, or a refusal naming the address.
func (a *Allowlist) Token(addr string) (Token, *Refusal) {
	t, ok := a.byToken[norm(addr)]
	if !ok {
		return Token{}, refuse(CodeTokenNotListed,
			"token %s is not in the allowlist reviewed %s; nothing permits it", addr, a.ReviewedAt)
	}
	return t, nil
}

// Router checks the contract the transaction calls.
func (a *Allowlist) Router(addr string) *Refusal {
	if len(a.byRouter) == 0 {
		return refuse(CodeNoRouters,
			"no router is allowlisted, so every swap is refused. This is the correct state until a "+
				"router is proven to work against this chain's factory — the canonical UniversalRouter "+
				"address exists here and is not wired to it")
	}
	if !a.byRouter[norm(addr)] {
		return refuse(CodeRouterNotListed, "router %s is not in the allowlist", addr)
	}
	return nil
}

// CheckSwap validates every part of a swap that this service could get wrong.
func (a *Allowlist) CheckSwap(router, tokenIn, tokenOut, recipient, agentWallet string, amountIn *big.Int, priceUSD float64) *Refusal {
	if r := a.Router(router); r != nil {
		return r
	}
	in, r := a.Token(tokenIn)
	if r != nil {
		return r
	}
	out, r := a.Token(tokenOut)
	if r != nil {
		return r
	}
	if norm(in.Address) == norm(out.Address) {
		return refuse(CodeSameToken, "token_in and token_out are both %s", in.Symbol)
	}
	// THE ONE THAT MATTERS MOST. A swap whose output goes anywhere but the
	// agent's own wallet is a withdrawal wearing a swap's clothes.
	if norm(recipient) != norm(agentWallet) {
		return refuse(CodeRecipientNotSelf,
			"recipient %s is not this agent's wallet %s; the signer will not send proceeds elsewhere",
			recipient, agentWallet)
	}
	return a.checkNotional(in, amountIn, priceUSD)
}

// CheckApprove validates an allowance.
func (a *Allowlist) CheckApprove(token, spender string, amount *big.Int, priceUSD float64) *Refusal {
	if r := a.Router(spender); r != nil {
		return r
	}
	t, r := a.Token(token)
	if r != nil {
		return r
	}
	// An unlimited approval is the standard convenience and the standard way a
	// compromised router drains a wallet. Bounded to a small multiple of one
	// trade: the cost is an extra approval now and then.
	cap := a.Limits.MaxTradeNotionalUSD * a.Limits.MaxApproveMultipleOfTrade
	return a.checkNotionalAgainst(t, amount, priceUSD, cap,
		"approval")
}

func (a *Allowlist) checkNotional(t Token, amount *big.Int, priceUSD float64) *Refusal {
	return a.checkNotionalAgainst(t, amount, priceUSD, a.Limits.MaxTradeNotionalUSD, "trade")
}

func (a *Allowlist) checkNotionalAgainst(t Token, amount *big.Int, priceUSD float64, capUSD float64, what string) *Refusal {
	if amount == nil || amount.Sign() <= 0 {
		return refuse(CodeAmountOverCap, "%s amount must be positive", what)
	}
	if capUSD <= 0 {
		return refuse(CodeAmountOverCap, "no %s cap is configured; refusing rather than assuming one", what)
	}
	units := unitsOf(amount, t.Decimals)
	notional := units * priceUSD
	if notional > capUSD {
		return refuse(CodeAmountOverCap,
			"%s of %.6f %s is about $%.2f, over the $%.2f cap enforced at the signer",
			what, units, t.Symbol, notional, capUSD)
	}
	return nil
}

// unitsOf converts a base-unit integer to a human amount.
func unitsOf(amount *big.Int, decimals int) float64 {
	f := new(big.Float).SetInt(amount)
	div := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	v, _ := new(big.Float).Quo(f, div).Float64()
	return v
}
