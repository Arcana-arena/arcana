// Package config loads the arbitrage venue list.
//
// THE VENUES A TOKEN TRADES ON come from two reviewed files, never from the
// chain at runtime:
//
//  1. the signer allowlist — the traded v3 pool and (for secondary tokens) the
//     1% referee pool. Reading the signer's file, rather than a copy of it, is
//     the same discipline the decision engine follows: the scanner and the
//     signer cannot drift apart on what a token's pool is.
//  2. config/robinhood-arbitrage.json — additional venues the allowlist does
//     not name (the dust Uniswap v2 pairs), plus the scanner's own settings.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// Config is the arbitrage scanner's view of what to compare.
type Config struct {
	ChainID          int64       `json:"chain_id"`
	MinNetProfitBps  float64     `json:"min_net_profit_bps"`
	ReferenceSizeUSD float64     `json:"reference_size_usd"`
	GasCostUSD       float64     `json:"gas_cost_usd"`
	ImpactBufferBps  float64     `json:"impact_buffer_bps"`
	QuoteToken       QuoteToken  `json:"quote_token"`
	Tokens           []Token     `json:"tokens"`
}

// QuoteToken is the pair's quote side (USDG).
type QuoteToken struct {
	Symbol   string `json:"symbol"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
}

// Token is one Stock Token and the venues it trades on.
type Token struct {
	Symbol   string  `json:"symbol"`
	Address  string  `json:"address"`
	Decimals int     `json:"decimals"`
	Venues   []Venue `json:"venues"`
}

// Venue is one pool for a token, identified by a stable id.
type Venue struct {
	ID     string `json:"id"`
	Dex    string `json:"dex"`
	Pool   string `json:"pool"`
	FeeBps int    `json:"fee_bps"`
}

type allowlistFile struct {
	ChainID int64 `json:"chain_id"`
	Quote   struct {
		Symbol   string `json:"symbol"`
		Address  string `json:"address"`
		Decimals int    `json:"decimals"`
	} `json:"quote_token"`
	Tokens []struct {
		Symbol         string `json:"symbol"`
		Address        string `json:"address"`
		Decimals       int    `json:"decimals"`
		Pool           string `json:"pool"`
		PoolFee        int    `json:"pool_fee"`
		RefereePool    string `json:"referee_pool"`
		RefereePoolFee int    `json:"referee_pool_fee"`
	} `json:"tokens"`
}

type extraFile struct {
	ChainID         int64   `json:"chain_id"`
	MinNetProfitBps float64 `json:"min_net_profit_bps"`
	ReferenceSize   float64 `json:"reference_size_usd"`
	GasCostUSD      float64 `json:"gas_cost_usd"`
	ImpactBufferBps float64 `json:"impact_buffer_bps"`
	ExtraVenues     []struct {
		Token  string `json:"token"`
		Dex    string `json:"dex"`
		Pool   string `json:"pool"`
		FeeBps int    `json:"fee_bps"`
	} `json:"extra_venues"`
}

// Load reads both files and builds the venue list.
func Load(allowlistPath, extraPath string) (*Config, error) {
	allow, err := loadAllowlist(allowlistPath)
	if err != nil {
		return nil, err
	}
	extra, err := loadExtra(extraPath)
	if err != nil {
		return nil, err
	}
	if allow.ChainID != extra.ChainID {
		return nil, fmt.Errorf("chain_id mismatch: allowlist %d vs extra %d", allow.ChainID, extra.ChainID)
	}

	extraByToken := map[string][]Venue{}
	for _, ev := range extra.ExtraVenues {
		extraByToken[ev.Token] = append(extraByToken[ev.Token], Venue{
			ID:     fmt.Sprintf("%s-%s", ev.Dex, ev.Pool),
			Dex:    ev.Dex,
			Pool:   ev.Pool,
			FeeBps: ev.FeeBps,
		})
	}

	cfg := &Config{
		ChainID:          allow.ChainID,
		MinNetProfitBps:  extra.MinNetProfitBps,
		ReferenceSizeUSD: extra.ReferenceSize,
		GasCostUSD:       extra.GasCostUSD,
		ImpactBufferBps:  extra.ImpactBufferBps,
		QuoteToken: QuoteToken{
			Symbol:   allow.Quote.Symbol,
			Address:  allow.Quote.Address,
			Decimals: allow.Quote.Decimals,
		},
	}

	for _, t := range allow.Tokens {
		tok := Token{Symbol: t.Symbol, Address: t.Address, Decimals: t.Decimals}
		if t.Pool == "" {
			return nil, fmt.Errorf("token %s has no traded pool", t.Symbol)
		}
		tok.Venues = append(tok.Venues, Venue{
			ID:     "uniswap-v3",
			Dex:    "uniswap-v3",
			Pool:   t.Pool,
			FeeBps: t.PoolFee / 100,
		})
		if t.RefereePool != "" {
			tok.Venues = append(tok.Venues, Venue{
				ID:     "uniswap-v3-referee",
				Dex:    "uniswap-v3",
				Pool:   t.RefereePool,
				FeeBps: t.RefereePoolFee / 100,
			})
		}
		tok.Venues = append(tok.Venues, extraByToken[t.Symbol]...)
		cfg.Tokens = append(cfg.Tokens, tok)
	}
	if len(cfg.Tokens) == 0 {
		return nil, errors.New("no tokens in allowlist")
	}
	return cfg, nil
}

func loadAllowlist(path string) (*allowlistFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read allowlist %s: %w", path, err)
	}
	var a allowlistFile
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("parse allowlist %s: %w", path, err)
	}
	if a.ChainID == 0 || a.Quote.Decimals == 0 {
		return nil, errors.New("allowlist: chain_id and quote_token.decimals are required")
	}
	return &a, nil
}

func loadExtra(path string) (*extraFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var e extraFile
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	if e.ReferenceSize <= 0 {
		return nil, errors.New("config: reference_size_usd must be > 0")
	}
	if e.GasCostUSD < 0 {
		return nil, errors.New("config: gas_cost_usd must be >= 0")
	}
	return &e, nil
}
