package execution

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
)

// Config is the tradable universe, READ FROM THE SIGNER'S OWN ALLOWLIST.
//
// Not a copy. If this package kept its own list of token addresses it would
// drift from the one the signer enforces, and the first symptom would be the
// engine confidently building a swap the signer refuses — or worse, the two
// agreeing on a symbol and disagreeing on which contract it means.
type Config struct {
	ChainID    int64      `json:"chain_id"`
	QuoteToken TokenCfg   `json:"quote_token"`
	Routers    []string   `json:"routers"`
	Tokens     []TokenCfg `json:"tokens"`
	// Lending is read for WATCHING only; see capital.go.
	Lending *LendingCfg `json:"lending,omitempty"`

	bySymbol map[string]TokenCfg
}

type TokenCfg struct {
	Symbol   string `json:"symbol"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
	Pool     string `json:"pool"`
	PoolFee  uint32 `json:"pool_fee"`
}

func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("execution config: %w", err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("execution config: %w", err)
	}
	if c.ChainID == 0 {
		return nil, fmt.Errorf("execution config: chain_id is required")
	}
	if len(c.Routers) == 0 {
		return nil, fmt.Errorf("execution config: no router, so nothing can be executed")
	}
	if c.QuoteToken.Address == "" || c.QuoteToken.Decimals == 0 {
		return nil, fmt.Errorf("execution config: quote_token must name an address and its decimals")
	}
	c.bySymbol = map[string]TokenCfg{}
	for _, t := range c.Tokens {
		c.bySymbol[strings.ToUpper(t.Symbol)] = t
	}
	return &c, nil
}

func (c *Config) Router() string { return c.Routers[0] }

// Token resolves a symbol the decider chose. An unknown symbol is an error and
// never a guess: the decider works from the market snapshot and the allowlist
// is what may actually be traded, and where those two disagree the allowlist
// wins by refusing.
func (c *Config) Token(symbol string) (TokenCfg, error) {
	t, ok := c.bySymbol[strings.ToUpper(symbol)]
	if !ok {
		return TokenCfg{}, fmt.Errorf("symbol %s is not in the execution allowlist", symbol)
	}
	return t, nil
}

// baseUnits converts a human quantity to a token's smallest unit, TRUNCATING.
//
// Truncation, not rounding: rounding up produces an amount the wallet may not
// have, and the failure arrives as a revert that costs gas. Rounding down can
// only ever leave dust behind.
func baseUnits(qty float64, decimals int) *big.Int {
	if qty <= 0 {
		return big.NewInt(0)
	}
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	v := new(big.Float).SetFloat64(qty)
	v.Mul(v, scale)
	out, _ := v.Int(nil)
	return out
}

// unitsToFloat is the inverse, for putting a chain-read balance back into the
// arithmetic the rest of the engine does in dollars and shares.
func unitsToFloat(v *big.Int, decimals int) float64 {
	if v == nil {
		return 0
	}
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	f := new(big.Float).SetInt(v)
	f.Quo(f, scale)
	out, _ := f.Float64()
	return out
}
