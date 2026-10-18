// Package engine scans every configured venue, compares executable quotes, and
// classifies each token's best cross-venue spread as executable or indicative.
package engine

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/config"
	"github.com/arcana/arbitrage/internal/store"
)

// Engine runs a scan over the configured venue list.
type Engine struct {
	chain *chain.Client
	cfg   *config.Config
	store *store.Store
}

func New(c *chain.Client, cfg *config.Config, st *store.Store) *Engine {
	return &Engine{chain: c, cfg: cfg, store: st}
}

// Latest returns the most recent scan's rows.
func (e *Engine) Latest(ctx context.Context) ([]store.OpportunityRow, error) {
	return e.store.LatestOpportunities(ctx)
}

// Recent returns the last N rows across scans.
func (e *Engine) Recent(ctx context.Context, limit int) ([]store.OpportunityRow, error) {
	return e.store.RecentOpportunities(ctx, limit)
}

// ScanResult summarizes one scan.
type ScanResult struct {
	ScannedTokens int    `json:"scanned_tokens"`
	Opportunities int    `json:"opportunities"`
	Errors        int    `json:"errors"`
	Note          string `json:"note,omitempty"`
}

type venueQuote struct {
	venue config.Venue
	buy   float64
	sell  float64
	liq   string
}

// ScanOnce reads every venue, computes the best buy and best sell per token,
// and appends one row per token. Idempotent only in the sense that it appends;
// running it twice records two scans, which is what a time series wants.
func (e *Engine) ScanOnce(ctx context.Context) (*ScanResult, error) {
	res := &ScanResult{ScannedTokens: len(e.cfg.Tokens)}
	gasBps := e.cfg.GasCostUSD / e.cfg.ReferenceSizeUSD * 10000
	// One timestamp per scan, shared by every row, so "latest scan" is one
	// max(ts) lookup instead of matching only the last-inserted row.
	scanTS := time.Now().UTC().Truncate(time.Second)

	for _, t := range e.cfg.Tokens {
		quotes, errs := e.readVenues(ctx, t)
		res.Errors += errs
		if len(quotes) == 0 {
			continue
		}

		bestBuy := quotes[0]
		bestSell := quotes[0]
		for _, q := range quotes[1:] {
			if q.buy < bestBuy.buy {
				bestBuy = q
			}
			if q.sell > bestSell.sell {
				bestSell = q
			}
		}

		gross := (bestSell.sell - bestBuy.buy) / bestBuy.buy * 10000
		net := gross - gasBps - e.cfg.ImpactBufferBps
		status := "indicative"
		if net >= e.cfg.MinNetProfitBps {
			status = "executable"
		}

		row := store.OpportunityRow{
			Symbol:           t.Symbol,
			VenueBuy:         bestBuy.venue.ID,
			VenueSell:        bestSell.venue.ID,
			BuyPrice:         bestBuy.buy,
			SellPrice:        bestSell.sell,
			GrossSpreadBps:   gross,
			EstNetProfitBps:  net,
			FeeBuyBps:        bestBuy.venue.FeeBps,
			FeeSellBps:       bestSell.venue.FeeBps,
			GasBps:           gasBps,
			ImpactBufferBps:  e.cfg.ImpactBufferBps,
			ReferenceSizeUSD: e.cfg.ReferenceSizeUSD,
			LiquidityBuy:     bestBuy.liq,
			LiquiditySell:    bestSell.liq,
			Status:           status,
		}
		if err := e.store.InsertOpportunity(ctx, scanTS, row); err != nil {
			log.Printf("arbitrage insert %s: %v", t.Symbol, err)
			res.Errors++
			continue
		}
		res.Opportunities++
	}

	errMsg := ""
	if res.Errors > 0 {
		errMsg = fmt.Sprintf("%d venue/token errors", res.Errors)
		res.Note = errMsg
	}
	// The heartbeat is written even when every venue failed, so a scanner that
	// ran into a broken chain and one that never ran stay distinguishable.
	if err := e.store.Heartbeat(ctx, res.Opportunities, errMsg); err != nil {
		log.Printf("arbitrage heartbeat: %v", err)
	}
	return res, nil
}

func (e *Engine) readVenues(ctx context.Context, t config.Token) ([]venueQuote, int) {
	out := make([]venueQuote, 0, len(t.Venues))
	errs := 0
	for _, v := range t.Venues {
		mid, err := e.chain.PoolPrice(ctx, v.Pool, t.Address, t.Decimals, e.cfg.QuoteToken.Decimals)
		if err != nil {
			log.Printf("arbitrage %s %s price: %v", t.Symbol, v.ID, err)
			errs++
			continue
		}
		liq, err := e.chain.Liquidity(ctx, v.Pool)
		if err != nil {
			log.Printf("arbitrage %s %s liquidity: %v", t.Symbol, v.ID, err)
			errs++
			continue
		}
		feeMul := float64(v.FeeBps) / 10000.0
		out = append(out, venueQuote{
			venue: v,
			buy:   mid * (1 + feeMul),
			sell:  mid * (1 - feeMul),
			liq:   liq.String(),
		})
	}
	return out, errs
}
