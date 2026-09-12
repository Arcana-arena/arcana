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

	// BlocklistUnreadable, when present, records that THIS token has no
	// readable isBlocked(), with the evidence for it. Absent means the check
	// applies in full, which is what every token gets by default.
	BlocklistUnreadable *BlocklistException `json:"blocklist_unreadable,omitempty"`
}

// BlocklistException is a per-token, evidence-carrying record that a token's
// isBlocked() cannot be read — and the exact chain behaviour that says so.
//
// WHY THIS IS NOT A FLAG. "Skip the blocklist check" as a boolean would be one
// line that disables a safety control everywhere, forever, with nothing to
// re-check and nothing to expire. This is the opposite shape: it names one
// token, it carries the payload that token is known to return, and the signer
// compares against that payload EVERY TIME IT SIGNS. The day the token starts
// answering, the exception stops applying on its own, because the recorded
// behaviour no longer matches what the chain does.
//
// WHY A CONTROL SELECTOR IS REQUIRED for an empty-data revert. A revert with
// no payload is exactly what a contract returns for a function that does not
// exist — and also what a real function could return. Calling a selector that
// certainly exists nowhere (0xdeadbeef) and observing the SAME payload is what
// turns "isBlocked reverted" into "this contract has no such function". For a
// custom-error payload the control is just as necessary: USDG returns
// 0x800ab12c for 0xdeadbeef too, which is how that payload was shown to be its
// unknown-selector error rather than a blocklist answer.
type BlocklistException struct {
	VerifiedAt        string `json:"verified_at"`
	RevertData        string `json:"revert_data"`
	ControlSelector   string `json:"control_selector"`
	ControlRevertData string `json:"control_revert_data"`
	Note              string `json:"note"`
}

// Matches reports whether an observed revert payload is the one recorded.
func (e *BlocklistException) Matches(observed string) bool {
	return strings.EqualFold(strings.TrimSpace(observed), strings.TrimSpace(e.RevertData))
}

// Limits are the bounds the PLATFORM imposes, and after the notional cap came
// off there is exactly one thing left in here that is about size — and it is
// not about the size of a trade.
//
// WHAT WAS REMOVED AND WHY. max_trade_notional_usd capped a single trade at
// $100. That is a statement about how large a position an owner may take, and
// how large a position to take is trading style. The platform provides the
// venue, executes, and measures; it does not decide how much of their own money
// somebody may commit to one idea. A $100 ceiling on a $50,000 book is not
// safety, it is the platform overruling the owner about their own strategy.
//
// WHAT DID NOT GO WITH IT, because these were never about size:
//
//	the two intents        this signer can build `approve` and `swap_exact_in`
//	                       and nothing else. There is no `data`, no `to`, no
//	                       `value`: a caller cannot express "send these tokens
//	                       somewhere" because the words do not exist.
//	the allowlist          only reviewed tokens, only reviewed routers.
//	recipient_not_agent_wallet  proceeds may only go to the agent's own wallet.
//	the signature cap      bounds how much of the PLATFORM's capacity one agent
//	                       may consume. Not the owner's money — ours.
//	unbounded approvals    see MaxApproveMultipleOfTrade below.
type Limits struct {
	// MaxApproveMultipleOfTrade is kept in the schema so an existing allowlist
	// still loads, and is no longer multiplied by anything. The approval rule
	// it used to take part in is now structural rather than monetary: see
	// CheckApprove.
	MaxApproveMultipleOfTrade float64 `json:"max_approve_multiple_of_trade"`
	MaxSignaturesPerDay       int     `json:"max_signatures_per_agent_per_day"`
}

type Allowlist struct {
	ChainID    int64    `json:"chain_id"`
	ReviewedAt string   `json:"reviewed_at"`
	QuoteToken Token    `json:"quote_token"`
	Routers    []string `json:"routers"`
	Tokens     []Token  `json:"tokens"`
	Limits     Limits   `json:"limits"`

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

	// An exception without its evidence is a note nobody can re-check later,
	// which is how a temporary workaround becomes permanent. Refusing to load
	// is the only response that cannot be ignored.
	for _, t := range a.byToken {
		ex := t.BlocklistUnreadable
		if ex == nil {
			continue
		}
		switch {
		case strings.TrimSpace(ex.VerifiedAt) == "":
			return nil, fmt.Errorf("allowlist: %s carries a blocklist exception with no verified_at date", t.Symbol)
		case strings.TrimSpace(ex.RevertData) == "":
			return nil, fmt.Errorf(
				"allowlist: %s carries a blocklist exception with no revert_data. The recorded payload is "+
					"what makes the exception expire on its own; without it there is nothing to compare against", t.Symbol)
		case strings.TrimSpace(ex.ControlSelector) == "" || strings.TrimSpace(ex.ControlRevertData) == "":
			return nil, fmt.Errorf(
				"allowlist: %s carries a blocklist exception with no control. A revert only proves the function "+
					"is absent if a selector that exists nowhere returns the same payload", t.Symbol)
		case !strings.EqualFold(ex.RevertData, ex.ControlRevertData):
			return nil, fmt.Errorf(
				"allowlist: %s records isBlocked() reverting with %s but its control selector %s reverting with %s. "+
					"Different payloads mean isBlocked() is answering something, not missing", t.Symbol,
				ex.RevertData, ex.ControlSelector, ex.ControlRevertData)
		}
	}
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
	CodeUnknownIntent    = "unknown_intent"
	CodeTokenNotListed   = "token_not_allowlisted"
	CodeRouterNotListed  = "router_not_allowlisted"
	CodeNoRouters        = "no_router_configured"
	CodeRecipientNotSelf = "recipient_not_agent_wallet"
	// amount_over_cap RETIRED 2026-09-11 with the trade notional ceiling. Kept
	// out of this list deliberately: a code nothing emits is a brake somebody
	// will build on. Two codes replace the two things it used to conflate.
	CodeAmountNotPositive = "amount_not_positive"
	CodeUnboundedApproval = "unbounded_approval"
	CodeDailyCap          = "daily_signature_cap"
	CodeSameToken         = "token_in_equals_token_out"
	CodeWalletBlocked     = "wallet_blocked"
	CodeTokenPaused       = "token_paused"
	CodeChainUnverifiable = "chain_state_unverifiable"
	CodeChainMismatch     = "chain_id_mismatch"
	CodeNoPoolFee         = "pool_fee_unknown"
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
func (a *Allowlist) CheckSwap(router, tokenIn, tokenOut, recipient, agentWallet string, amountIn *big.Int) *Refusal {
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
	// NO SIZE CEILING. How much of their own money an owner commits to one
	// trade is their decision. What still bounds a swap is real rather than
	// policy: the wallet's balance, and the min_out floor the transaction
	// carries into the pool.
	return checkPositive(in, amountIn, "trade")
}

// CheckApprove validates an allowance.
//
// THE RULE IS STRUCTURAL NOW, NOT MONETARY. It used to be a dollar cap derived
// from the trade ceiling, and when that ceiling came off this could have gone
// with it. It should not: an unlimited approval is not a large trade, it is a
// standing right for somebody else to take everything in the wallet, which is
// the thing the two-intent design exists to make inexpressible.
//
// So the bound is on the SHAPE of the number rather than its value. The broker
// approves exactly the amount of the swap it is about to send, so any real
// allowance is a quantity of a token. 2^255 base units is about 5.8e58 whole
// tokens at eighteen decimals — larger than the supply of anything that exists,
// which is precisely why `type(uint256).max` and `2^255-1` are the two idioms
// for "infinite". A number up there is not a quantity; it is a word.
//
// Everything below it is the owner's business.
func (a *Allowlist) CheckApprove(token, spender string, amount *big.Int) *Refusal {
	if r := a.Router(spender); r != nil {
		return r
	}
	t, r := a.Token(token)
	if r != nil {
		return r
	}
	if ref := checkPositive(t, amount, "approval"); ref != nil {
		return ref
	}
	if amount.Cmp(unboundedApproval) >= 0 {
		return refuse(CodeUnboundedApproval,
			"an approval of %s base units of %s is the infinite-allowance idiom, not a quantity: "+
				"it is larger than the supply of any token that exists. The signer grants "+
				"allowances for amounts, not standing rights",
			amount.String(), t.Symbol)
	}
	return nil
}

// unboundedApproval is 2^255. See CheckApprove for why this and not a dollar.
var unboundedApproval = new(big.Int).Lsh(big.NewInt(1), 255)

func checkPositive(t Token, amount *big.Int, what string) *Refusal {
	if amount == nil || amount.Sign() <= 0 {
		return refuse(CodeAmountNotPositive, "%s amount must be positive", what)
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

// PoolFeeFor resolves the fee tier of the pool a swap must route through.
//
// THE FEE BELONGS TO THE PAIR, NOT TO ONE SIDE. The first version read it from
// token_out, which is correct for a buy — token_out is the stock token, and
// that is where pool_fee is recorded — and silently wrong for a SELL, where
// token_out is the quote token and its allowlist entry has no pool_fee at all.
// A fee of 0 is not a fee tier: the router derives the pool address from it,
// derives an address with no contract at it, and reverts with no message for
// about 30k gas. Every sell this service ever signed would have done that, and
// the only reason nobody noticed is that the first real trade was a buy.
//
// So the fee is taken from whichever side is NOT the quote token, and a pair
// that does not have exactly one such side is refused rather than guessed at.
func (a *Allowlist) PoolFeeFor(tokenIn, tokenOut string) (uint32, *Refusal) {
	q := norm(a.QuoteToken.Address)
	inIsQuote, outIsQuote := norm(tokenIn) == q, norm(tokenOut) == q

	var side string
	switch {
	case inIsQuote && outIsQuote:
		return 0, refuse(CodeSameToken, "both sides of this swap are the quote token")
	case inIsQuote:
		side = tokenOut
	case outIsQuote:
		side = tokenIn
	default:
		return 0, refuse(CodeNoPoolFee,
			"neither %s nor %s is the quote token %s, so there is no pool this service knows how "+
				"to route through. Stock-to-stock swaps are not something the allowlist describes",
			tokenIn, tokenOut, a.QuoteToken.Address)
	}

	t, ref := a.Token(side)
	if ref != nil {
		return 0, ref
	}
	if t.PoolFee == 0 {
		// Refusing rather than signing. A transaction built on a fee tier of
		// zero is guaranteed to revert, and signing it would spend the agent's
		// gas to discover something knowable here for free.
		return 0, refuse(CodeNoPoolFee,
			"%s has no pool_fee in the allowlist, so the pool to route through is unknown. "+
				"Refusing rather than signing a transaction that would revert", t.Symbol)
	}
	return t.PoolFee, nil
}
