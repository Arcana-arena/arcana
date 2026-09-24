package execution

// ARCANA CAPITAL: reading a Morpho position. READ-ONLY — nothing in this file
// builds a transaction, and nothing that calls it may sign on its answer yet
// (architecture.md §17.7 day 5).
//
// UNITS, because §17.7 names them as what sinks this day. Everything read from
// the chain is an integer in base units and stays one until the last step,
// where it is converted once with the token's own decimals from the allowlist:
//
//	collateral  NVDA base units (18 decimals)
//	debt        USDG base units (6 decimals), rounded UP the way Morpho values it
//	price()     Morpho oracle scale: 1e36 * 10^(loanDecimals - collateralDecimals)
//	lltv        WAD (1e18)
//
// Health factor = collateral * price / 1e36 * lltv / 1e18 / debt, computed in
// base units of the loan token so no decimal ever has to be remembered.

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"
)

type LendingCfg struct {
	Enabled bool               `json:"enabled"`
	Morpho  string             `json:"morpho"`
	Markets []LendingMarketCfg `json:"markets"`
	// The platform caps, in whole USDG, exactly as the signer reads them. The
	// signer enforces them in base units; the decider needs them to know what
	// it may propose.
	Limits struct {
		MaxBorrowPerTxUSDG  string `json:"max_borrow_per_tx_usdg"`
		MaxDebtPerAgentUSDG string `json:"max_debt_per_agent_usdg"`
	} `json:"limits"`
}

// PlatformCaps returns the per-transaction and per-agent caps in whole USDG,
// or zeros when they are absent — which makes every borrow refuse.
func (b *Broker) PlatformCaps() (perTx, perAgent float64) {
	if b.cfg.Lending == nil {
		return 0, 0
	}
	fmt.Sscanf(b.cfg.Lending.Limits.MaxBorrowPerTxUSDG, "%g", &perTx)
	fmt.Sscanf(b.cfg.Lending.Limits.MaxDebtPerAgentUSDG, "%g", &perAgent)
	return perTx, perAgent
}

// LendingEnabled is the allowlist's switch. The signer enforces it; the engine
// reads it only to say so on the record instead of discovering it as a refusal.
func (b *Broker) LendingEnabled() bool { return b.cfg.Lending != nil && b.cfg.Lending.Enabled }

type LendingMarketCfg struct {
	Name            string `json:"name"`
	ID              string `json:"id"`
	LoanToken       string `json:"loan_token"`
	CollateralToken string `json:"collateral_token"`
	Oracle          string `json:"oracle"`
	IRM             string `json:"irm"`
	LLTV            string `json:"lltv"`
	OracleFeeds     struct {
		Base  string `json:"base"`
		Quote string `json:"quote"`
	} `json:"oracle_feeds"`
}

// CapitalMarkets is the allowlisted lending markets, empty when there are none.
// Reading does not depend on `enabled`: the position must be watched whether or
// not ARCANA may act on it, the same way pause keeps the watcher (§17.4).
func (b *Broker) CapitalMarkets() []LendingMarketCfg {
	if b.cfg.Lending == nil {
		return nil
	}
	return b.cfg.Lending.Markets
}

// LendingPosition is one wallet's raw position in one market.
type LendingPosition struct {
	BorrowShares *big.Int
	Collateral   *big.Int
}

func (p LendingPosition) Empty() bool { return p.BorrowShares.Sign() == 0 && p.Collateral.Sign() == 0 }

// ReadPosition reads Morpho.position(id, wallet).
func (b *Broker) ReadPosition(ctx context.Context, m LendingMarketCfg, wallet string) (LendingPosition, error) {
	data := "0x93c52062" + strings.TrimPrefix(strings.ToLower(m.ID), "0x") + padAddr(wallet)
	raw, err := b.rpc.hexString(ctx, "eth_call", []any{map[string]string{"to": b.cfg.Lending.Morpho, "data": data}, "latest"})
	if err != nil {
		return LendingPosition{}, fmt.Errorf("position(%s): %w", wallet, err)
	}
	shares, err := word(raw, 1)
	if err != nil {
		return LendingPosition{}, fmt.Errorf("position(%s): %w", wallet, err)
	}
	coll, err := word(raw, 2)
	if err != nil {
		return LendingPosition{}, fmt.Errorf("position(%s): %w", wallet, err)
	}
	return LendingPosition{BorrowShares: shares, Collateral: coll}, nil
}

// MarketState is everything about a market that is the same for every wallet
// in it, read once per scan.
type MarketState struct {
	TotalSupplyAssets *big.Int
	TotalBorrowAssets *big.Int
	TotalBorrowShares *big.Int
	LastUpdate        *big.Int
	Fee               *big.Int
	BorrowRateBps     float64  // annual; -1 when the IRM could not be read
	OraclePrice       *big.Int // Morpho oracle scale
	PoolPrice         float64  // USDG per collateral token; 0 when unreadable
	BaseFeedAge       *int     // seconds; nil when unreadable
	QuoteFeedAge      *int
	OraclePaused      *bool
	CollateralSymbol  string
	CollateralDec     int
	LoanDec           int
	LLTV              *big.Int
}

// ReadMarketState reads the market's totals, its oracle, and the three things
// the oracle does not check for itself (docs/go-no-go-lending.md condition 2).
// Only the totals and the oracle price are required; the rest are recorded as
// unknown when they cannot be read, never as fine.
func (b *Broker) ReadMarketState(ctx context.Context, m LendingMarketCfg, now time.Time) (MarketState, error) {
	var s MarketState
	lltv, ok := new(big.Int).SetString(m.LLTV, 10)
	if !ok {
		return s, fmt.Errorf("market %s: lltv %q is not an integer", m.Name, m.LLTV)
	}
	s.LLTV = lltv
	coll, err := b.tokenByAddress(m.CollateralToken)
	if err != nil {
		return s, err
	}
	s.CollateralSymbol, s.CollateralDec, s.LoanDec = coll.Symbol, coll.Decimals, b.cfg.QuoteToken.Decimals

	raw, err := b.rpc.hexString(ctx, "eth_call", []any{map[string]string{
		"to": b.cfg.Lending.Morpho, "data": "0x5c60e39a" + strings.TrimPrefix(strings.ToLower(m.ID), "0x")}, "latest"})
	if err != nil {
		return s, fmt.Errorf("market(%s): %w", m.Name, err)
	}
	words := make([]*big.Int, 6)
	for i := range words {
		if words[i], err = word(raw, i); err != nil {
			return s, fmt.Errorf("market(%s): %w", m.Name, err)
		}
	}
	s.TotalSupplyAssets, s.TotalBorrowAssets, s.TotalBorrowShares = words[0], words[2], words[3]
	s.LastUpdate, s.Fee = words[4], words[5]

	// The IRM's current rate: borrowRateView(marketParams, market), per second
	// in WAD. Unreadable is -1, which the decider treats as above any mandate.
	s.BorrowRateBps = -1
	irmData := "0x8c00bf6b" + padAddr(m.LoanToken) + padAddr(m.CollateralToken) + padAddr(m.Oracle) + padAddr(m.IRM) + padUint(lltv)
	for _, w := range words {
		irmData += padUint(w)
	}
	if rr, rerr := b.rpc.hexString(ctx, "eth_call", []any{map[string]string{"to": m.IRM, "data": irmData}, "latest"}); rerr == nil {
		if perSec, werr := word(rr, 0); werr == nil {
			f, _ := new(big.Float).Quo(new(big.Float).SetInt(perSec), new(big.Float).SetInt(pow10i(18))).Float64()
			s.BorrowRateBps = f * 31536000 * 10000
		}
	}

	raw, err = b.rpc.hexString(ctx, "eth_call", []any{map[string]string{"to": m.Oracle, "data": "0xa035b1fe"}, "latest"})
	if err != nil {
		return s, fmt.Errorf("oracle price() for %s: %w", m.Name, err)
	}
	if s.OraclePrice, err = word(raw, 0); err != nil || s.OraclePrice.Sign() <= 0 {
		return s, fmt.Errorf("oracle price() for %s is not a price", m.Name)
	}

	if p, perr := b.PoolPrice(ctx, coll.Symbol); perr == nil {
		s.PoolPrice = p
	}
	s.BaseFeedAge = b.feedAge(ctx, m.OracleFeeds.Base, now)
	s.QuoteFeedAge = b.feedAge(ctx, m.OracleFeeds.Quote, now)
	if raw, err := b.rpc.hexString(ctx, "eth_call", []any{map[string]string{
		"to": m.CollateralToken, "data": "0x7706ba52"}, "latest"}); err == nil { // oraclePaused()
		if v, werr := word(raw, 0); werr == nil {
			p := v.Sign() != 0
			s.OraclePaused = &p
		}
	}
	return s, nil
}

func (b *Broker) feedAge(ctx context.Context, feed string, now time.Time) *int {
	if feed == "" {
		return nil
	}
	raw, err := b.rpc.hexString(ctx, "eth_call", []any{map[string]string{"to": feed, "data": "0xfeaf968c"}, "latest"})
	if err != nil {
		return nil
	}
	updated, err := word(raw, 3)
	if err != nil || updated.Sign() == 0 {
		return nil
	}
	age := int(now.Unix() - updated.Int64())
	return &age
}

func (b *Broker) tokenByAddress(addr string) (TokenCfg, error) {
	for _, t := range b.cfg.Tokens {
		if strings.EqualFold(t.Address, addr) {
			return t, nil
		}
	}
	return TokenCfg{}, fmt.Errorf("collateral %s is not an allowlisted token", addr)
}

// Reading is a position valued: what goes in a capital_positions row.
type Reading struct {
	CollateralQty     float64
	CollateralValue   float64 // USDG, at the oracle price
	Debt              float64 // USDG
	LLTV              float64
	OraclePrice       float64 // USDG per collateral token
	PoolPrice         *float64
	HealthFactor      *float64 // nil: no debt
	HealthFactorWorst *float64
	LiquidationPrice  *float64 // USDG per collateral token at which HF = 1
}

// Value turns a raw position into the figures a person reads.
func Value(p LendingPosition, s MarketState) Reading {
	// Debt in loan base units, rounded up: shares * (A + 1) / (S + 1e6).
	debt := new(big.Int)
	if p.BorrowShares.Sign() > 0 {
		num := new(big.Int).Mul(p.BorrowShares, new(big.Int).Add(s.TotalBorrowAssets, big.NewInt(1)))
		den := new(big.Int).Add(s.TotalBorrowShares, big.NewInt(1_000000))
		q, r := new(big.Int).QuoRem(num, den, new(big.Int))
		if r.Sign() > 0 {
			q.Add(q, big.NewInt(1))
		}
		debt = q
	}
	// Collateral value in loan base units: collateral * price / 1e36.
	value := new(big.Int).Mul(p.Collateral, s.OraclePrice)
	value.Quo(value, pow10i(36))

	r := Reading{
		CollateralQty:   toFloat(p.Collateral, s.CollateralDec),
		CollateralValue: toFloat(value, s.LoanDec),
		Debt:            toFloat(debt, s.LoanDec),
		LLTV:            toFloat(s.LLTV, 18),
		// price / 1e36 * 10^(collDec - loanDec) = price / 10^(36 - collDec + loanDec)
		OraclePrice: toFloat(s.OraclePrice, 36-s.CollateralDec+s.LoanDec),
	}
	if s.PoolPrice > 0 {
		pp := s.PoolPrice
		r.PoolPrice = &pp
	}
	if debt.Sign() > 0 {
		// HF in exact integers first: value * lltv / 1e18, over debt.
		maxBorrow := new(big.Int).Mul(value, s.LLTV)
		maxBorrow.Quo(maxBorrow, pow10i(18))
		hf := new(big.Float).Quo(new(big.Float).SetInt(maxBorrow), new(big.Float).SetInt(debt))
		h, _ := hf.Float64()
		r.HealthFactor = &h

		worst := r.OraclePrice
		if r.PoolPrice != nil && *r.PoolPrice < worst {
			worst = *r.PoolPrice
		}
		hw := r.CollateralQty * worst * r.LLTV / r.Debt
		r.HealthFactorWorst = &hw

		if r.CollateralQty > 0 {
			lp := r.Debt / (r.CollateralQty * r.LLTV)
			r.LiquidationPrice = &lp
		}
	}
	return r
}

func toFloat(v *big.Int, decimals int) float64 {
	f := new(big.Float).SetInt(v)
	if decimals > 0 {
		f.Quo(f, new(big.Float).SetInt(pow10i(decimals)))
	} else if decimals < 0 {
		f.Mul(f, new(big.Float).SetInt(pow10i(-decimals)))
	}
	out, _ := f.Float64()
	return out
}

// word reads the i-th 32-byte word of an ABI-encoded result.
func word(hexResult string, i int) (*big.Int, error) {
	body := strings.TrimPrefix(hexResult, "0x")
	if len(body) < (i+1)*64 {
		return nil, fmt.Errorf("short answer: %d hex chars, wanted word %d", len(body), i)
	}
	v, ok := new(big.Int).SetString(body[i*64:(i+1)*64], 16)
	if !ok {
		return nil, fmt.Errorf("word %d is not hex", i)
	}
	return v, nil
}

// ToWhole converts base units to whole units with the given decimals.
func ToWhole(v *big.Int, decimals int) float64 { return toFloat(v, decimals) }
