package policy

// ARCANA CAPITAL: the three lending shapes, and the caps on them.
//
// DISABLED UNTIL SOMEONE SAYS OTHERWISE IN A COMMIT. `lending.enabled` is false
// in the shipped allowlist, and every lending intent is refused with
// lending_not_enabled while it is. The shapes exist so they can be proved by
// execution before anything is at stake; turning them on is a reviewed edit to
// one boolean, not a deploy of new code.
//
// THE CAPS ARE IN WHOLE USDG IN THE FILE AND IN BASE UNITS EVERYWHERE ELSE.
// architecture.md §17.7 names the failure: a cap written in one unit and
// compared in another is off by 10^6 here (USDG has six decimals) and would not
// be a cap. So the file says "100", Load converts it once with the quote
// token's own decimals, and nothing downstream ever sees a whole-USDG number.

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/arcana/signer/internal/keys"
)

type LendingMarket struct {
	Name            string `json:"name"`
	ID              string `json:"id"`
	LoanToken       string `json:"loan_token"`
	CollateralToken string `json:"collateral_token"`
	Oracle          string `json:"oracle"`
	IRM             string `json:"irm"`
	LLTV            string `json:"lltv"`

	lltv *big.Int
}

// Params is the market's MarketParams tuple, exactly as Morpho hashes it.
func (m LendingMarket) Params() (loan, collateral, oracle, irm string, lltv *big.Int) {
	return m.LoanToken, m.CollateralToken, m.Oracle, m.IRM, new(big.Int).Set(m.lltv)
}

type LendingLimits struct {
	MaxBorrowPerTxUSDG  string `json:"max_borrow_per_tx_usdg"`
	MaxDebtPerAgentUSDG string `json:"max_debt_per_agent_usdg"`
	Note                string `json:"note"`
	maxBorrowPerTx      *big.Int
	maxDebtPerAgent     *big.Int
}

type Lending struct {
	Enabled bool            `json:"enabled"`
	Morpho  string          `json:"morpho"`
	Markets []LendingMarket `json:"markets"`
	Limits  LendingLimits   `json:"limits"`

	byID map[string]LendingMarket
}

const (
	CodeLendingDisabled   = "lending_not_enabled"
	CodeMarketNotListed   = "market_not_allowlisted"
	CodeBorrowOverTxCap   = "borrow_over_tx_cap"
	CodeDebtOverAgentCap  = "debt_over_agent_cap"
	CodeLendingTokenWrong = "lending_token_not_in_market"
)

// loadLending validates the lending section, or leaves it nil when absent.
//
// EVERY MARKET ID IS RECOMPUTED FROM ITS PARAMETERS. Morpho identifies a market
// by keccak256(abi.encode(MarketParams)), and the signer builds calldata from the
// parameters, not the id. A file whose id and parameters disagree describes two
// different markets under one name — reviewed as one, signed as the other — so
// it does not load.
func (a *Allowlist) loadLending() error {
	l := a.Lending
	if l == nil {
		return nil
	}
	if strings.TrimSpace(l.Morpho) == "" {
		return fmt.Errorf("allowlist: lending.morpho is required")
	}
	if len(l.Markets) == 0 {
		return fmt.Errorf("allowlist: lending lists no market")
	}
	l.byID = map[string]LendingMarket{}
	for i, m := range l.Markets {
		lltv, ok := new(big.Int).SetString(strings.TrimSpace(m.LLTV), 10)
		if !ok || lltv.Sign() <= 0 || lltv.Cmp(wad) >= 0 {
			return fmt.Errorf("allowlist: lending market %q has lltv %q, which is not a WAD fraction below 1e18", m.Name, m.LLTV)
		}
		m.lltv = lltv
		if norm(m.LoanToken) != norm(a.QuoteToken.Address) {
			return fmt.Errorf("allowlist: lending market %q lends %s, not the quote token; the caps are in quote-token units and would not mean anything", m.Name, m.LoanToken)
		}
		if _, ok := a.byToken[norm(m.CollateralToken)]; !ok {
			return fmt.Errorf("allowlist: lending market %q takes %s as collateral, which is not an allowlisted token", m.Name, m.CollateralToken)
		}
		got := MarketID(m.LoanToken, m.CollateralToken, m.Oracle, m.IRM, lltv)
		if norm(got) != norm(m.ID) {
			return fmt.Errorf("allowlist: lending market %q records id %s but its parameters hash to %s", m.Name, m.ID, got)
		}
		l.Markets[i] = m
		l.byID[norm(m.ID)] = m
	}

	// Whole USDG in the file, base units from here on. See the package note.
	dec := a.QuoteToken.Decimals
	if dec <= 0 {
		return fmt.Errorf("allowlist: quote token has no decimals, so the lending caps cannot be converted")
	}
	var err error
	if l.Limits.maxBorrowPerTx, err = wholeToBase(l.Limits.MaxBorrowPerTxUSDG, dec); err != nil {
		return fmt.Errorf("allowlist: lending.limits.max_borrow_per_tx_usdg: %w", err)
	}
	if l.Limits.maxDebtPerAgent, err = wholeToBase(l.Limits.MaxDebtPerAgentUSDG, dec); err != nil {
		return fmt.Errorf("allowlist: lending.limits.max_debt_per_agent_usdg: %w", err)
	}
	if l.Limits.maxBorrowPerTx.Cmp(l.Limits.maxDebtPerAgent) > 0 {
		return fmt.Errorf("allowlist: the per-transaction borrow cap is above the per-agent debt cap")
	}
	return nil
}

var wad = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// wholeToBase turns "100" into 100 * 10^decimals. Whole units only: a cap with
// a fractional part is refused rather than rounded, because a rounded cap is a
// different cap from the one that was reviewed.
func wholeToBase(s string, decimals int) (*big.Int, error) {
	v, ok := new(big.Int).SetString(strings.TrimSpace(s), 10)
	if !ok || v.Sign() <= 0 {
		return nil, fmt.Errorf("%q is not a positive whole number of USDG", s)
	}
	return v.Mul(v, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)), nil
}

// MarketID is keccak256(abi.encode(loan, collateral, oracle, irm, lltv)).
func MarketID(loan, collateral, oracle, irm string, lltv *big.Int) string {
	var buf []byte
	for _, a := range []string{loan, collateral, oracle, irm} {
		buf = append(buf, word(a)...)
	}
	buf = append(buf, uintWord(lltv)...)
	return "0x" + hex.EncodeToString(keys.Keccak256(buf))
}

func word(addr string) []byte {
	b, _ := hex.DecodeString(strings.TrimPrefix(norm(addr), "0x"))
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func uintWord(v *big.Int) []byte {
	out := make([]byte, 32)
	b := v.Bytes()
	copy(out[32-len(b):], b)
	return out
}

// lendingOn returns the lending section, or a refusal when lending is off.
func (a *Allowlist) lendingOn() (*Lending, *Refusal) {
	if a.Lending == nil || !a.Lending.Enabled {
		return nil, refuse(CodeLendingDisabled,
			"lending is not enabled in the allowlist reviewed %s. The shapes exist so they can be proved "+
				"before anything is at stake; enabling them is a reviewed commit, not a request", a.ReviewedAt)
	}
	return a.Lending, nil
}

// Market resolves an allowlisted market by id.
func (a *Allowlist) Market(id string) (LendingMarket, string, *Refusal) {
	l, r := a.lendingOn()
	if r != nil {
		return LendingMarket{}, "", r
	}
	m, ok := l.byID[norm(id)]
	if !ok {
		return LendingMarket{}, "", refuse(CodeMarketNotListed, "market %s is not in the lending allowlist", id)
	}
	return m, l.Morpho, nil
}

// CheckLendingApprove allows an allowance to Morpho, and only for a token that
// one of the allowlisted markets actually uses. The spender is not a parameter.
func (a *Allowlist) CheckLendingApprove(marketID, token string, amount *big.Int) (string, *Refusal) {
	m, morpho, r := a.Market(marketID)
	if r != nil {
		return "", r
	}
	if norm(token) != norm(m.CollateralToken) && norm(token) != norm(m.LoanToken) {
		return "", refuse(CodeLendingTokenWrong, "token %s is neither the collateral nor the loan token of %s", token, m.Name)
	}
	t, r := a.Token(token)
	if r != nil {
		return "", r
	}
	if r := checkPositive(t, amount, "approval"); r != nil {
		return "", r
	}
	if amount.Cmp(unboundedApproval) >= 0 {
		return "", refuse(CodeUnboundedApproval,
			"an approval of %s base units of %s is the infinite-allowance idiom, not a quantity", amount, t.Symbol)
	}
	return morpho, nil
}

// CheckSupply allows collateral in; the size is the owner's.
func (a *Allowlist) CheckSupply(marketID string, amount *big.Int) (LendingMarket, string, *Refusal) {
	m, morpho, r := a.Market(marketID)
	if r != nil {
		return m, "", r
	}
	t, _ := a.Token(m.CollateralToken)
	return m, morpho, checkPositive(t, amount, "supply")
}

// CheckRepay allows debt down. It is not capped: repaying only reduces risk.
func (a *Allowlist) CheckRepay(marketID string, amount *big.Int) (LendingMarket, string, *Refusal) {
	m, morpho, r := a.Market(marketID)
	if r != nil {
		return m, "", r
	}
	return m, morpho, checkPositive(a.QuoteToken, amount, "repay")
}

// CheckBorrow applies both caps. currentDebt is read from the chain by the
// caller in base units; nil means it could not be read, which refuses.
func (a *Allowlist) CheckBorrow(marketID string, amount, currentDebt *big.Int) (LendingMarket, string, *Refusal) {
	m, morpho, r := a.Market(marketID)
	if r != nil {
		return m, "", r
	}
	if r := checkPositive(a.QuoteToken, amount, "borrow"); r != nil {
		return m, "", r
	}
	lim := a.Lending.Limits
	dec := a.QuoteToken.Decimals
	if amount.Cmp(lim.maxBorrowPerTx) > 0 {
		return m, "", refuse(CodeBorrowOverTxCap,
			"a borrow of %s USDG is over the per-transaction cap of %s USDG (%s and %s base units)",
			human(amount, dec), human(lim.maxBorrowPerTx, dec), amount, lim.maxBorrowPerTx)
	}
	if currentDebt == nil {
		return m, "", refuse(CodeChainUnverifiable,
			"the agent's current debt in %s could not be read, so the per-agent cap cannot be applied. "+
				"Refusing: could not check is not the same as fine", m.Name)
	}
	after := new(big.Int).Add(currentDebt, amount)
	if after.Cmp(lim.maxDebtPerAgent) > 0 {
		return m, "", refuse(CodeDebtOverAgentCap,
			"debt would be %s USDG after this borrow (%s now + %s), over the per-agent cap of %s USDG",
			human(after, dec), human(currentDebt, dec), human(amount, dec), human(lim.maxDebtPerAgent, dec))
	}
	return m, morpho, nil
}

// MaxBorrowPerTx and MaxDebtPerAgent expose the converted caps, in base units.
func (a *Allowlist) MaxBorrowPerTx() *big.Int {
	return new(big.Int).Set(a.Lending.Limits.maxBorrowPerTx)
}
func (a *Allowlist) MaxDebtPerAgent() *big.Int {
	return new(big.Int).Set(a.Lending.Limits.maxDebtPerAgent)
}

func human(v *big.Int, decimals int) string {
	f := new(big.Float).SetInt(v)
	f.Quo(f, new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)))
	return f.Text('f', decimals)
}
