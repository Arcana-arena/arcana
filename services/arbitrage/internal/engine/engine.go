// Package engine scans every configured venue, compares executable quotes, and
// classifies each token's best cross-venue spread as executable or indicative.
package engine

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/big"
	"strconv"
	"strings"
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
	ScannedTokens int `json:"scanned_tokens"`
	Opportunities int `json:"opportunities"`
	Errors        int `json:"errors"`
	// SingleVenue counts tokens whose venues did not include two distinct
	// pools. They produce no row on purpose: comparing a pool with itself
	// measures its own round trip, which is not an opportunity.
	SingleVenue int    `json:"single_venue_tokens,omitempty"`
	Note        string `json:"note,omitempty"`
}

type venueQuote struct {
	venue config.Venue
	buy   float64
	sell  float64
	liq   string
	// reserve is a V2 pair's quote-side reserve in quote-token units, and
	// reserveKnown says whether that number exists at all (V3 venues do not
	// report one). It is what stops a dust pair from ever classifying as
	// executable, however its price reads.
	reserve      float64
	reserveKnown bool
}

// bestQuotePair picks the two DISTINCT pools with the largest (sell − buy).
//
// DISTINCT POOLS, NOT DISTINCT NAMES. Comparing a pool with itself measures the
// round trip through its own fee — always negative, never an opportunity — and
// that is what every single-venue token used to record: AAPL's row was its one
// pool bought at mid×(1+fee) and sold at mid×(1−fee), i.e. exactly −2×fee.
func bestQuotePair(quotes []venueQuote) (buy, sell venueQuote, ok bool) {
	for i := range quotes {
		for j := range quotes {
			if i == j || strings.EqualFold(quotes[i].venue.Pool, quotes[j].venue.Pool) {
				continue
			}
			if !ok || quotes[j].sell-quotes[i].buy > sell.sell-buy.buy {
				buy, sell, ok = quotes[i], quotes[j], true
			}
		}
	}
	return buy, sell, ok
}

// thinVenue reports whether a venue is known to hold less of the quote token
// than the size being priced. Only V2 venues answer that question today.
func thinVenue(q venueQuote, sizeUSD float64) bool {
	return q.reserveKnown && q.reserve < sizeUSD
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

		bestBuy, bestSell, pairOK := bestQuotePair(quotes)
		if !pairOK {
			res.SingleVenue++
			continue
		}

		gross := (bestSell.sell - bestBuy.buy) / bestBuy.buy * 10000
		net := gross - gasBps - e.cfg.ImpactBufferBps
		status := "indicative"
		thin := thinVenue(bestBuy, e.cfg.ReferenceSizeUSD) || thinVenue(bestSell, e.cfg.ReferenceSizeUSD)
		if net >= e.cfg.MinNetProfitBps {
			if thin {
				// A price that says "profitable" on a pair that cannot carry the
				// size is not an opportunity. The config lists those V2 pairs "so
				// the scanner can measure them, not because they are tradeable",
				// and this is the line that keeps that true.
				log.Printf("arbitrage %s: net %.1f bps but a venue holds less than the reference size — recorded indicative",
					t.Symbol, net)
			} else {
				status = "executable"
			}
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

	// The scan says why a token produced no row, in the order the numbers mean
	// something: a venue that failed to read is a defect; a token with one venue
	// is a shape of the market.
	var notes []string
	errMsg := ""
	if res.Errors > 0 {
		errMsg = fmt.Sprintf("%d venue/token errors", res.Errors)
		notes = append(notes, errMsg)
	}
	if res.SingleVenue > 0 {
		notes = append(notes, fmt.Sprintf("%d token(s) have no second venue to compare", res.SingleVenue))
	}
	res.Note = strings.Join(notes, "; ")
	// The heartbeat carries ERRORS only: it is what an operator alerts on, and
	// "this token has one pool" is not a failure.
	if err := e.store.Heartbeat(ctx, res.Opportunities, errMsg); err != nil {
		log.Printf("arbitrage heartbeat: %v", err)
	}
	return res, nil
}

func (e *Engine) readVenues(ctx context.Context, t config.Token) ([]venueQuote, int) {
	out := make([]venueQuote, 0, len(t.Venues))
	errs := 0
	for _, v := range t.Venues {
		var (
			mid      float64
			liq      string
			reserve  float64
			reserveK bool
			err      error
		)
		switch v.Dex {
		case "uniswap-v2":
			// V2 IS READ AS V2. This used to call the v3 reader for every venue,
			// so slot0() on a V2 pair reverted and five venues were dropped as
			// errors on every scan.
			var reserveRaw string
			mid, reserveRaw, err = e.chain.V2Quote(ctx, v.Pool, t.Address, t.Decimals, e.cfg.QuoteToken.Decimals)
			if err == nil {
				liq = reserveRaw
				if f, ferr := strconv.ParseFloat(reserveRaw, 64); ferr == nil {
					reserve = f / math.Pow(10, float64(e.cfg.QuoteToken.Decimals))
					reserveK = true
				}
			}
		case "uniswap-v3":
			mid, err = e.chain.PoolPrice(ctx, v.Pool, t.Address, t.Decimals, e.cfg.QuoteToken.Decimals)
			if err == nil {
				var l *big.Int
				if l, err = e.chain.Liquidity(ctx, v.Pool); err == nil {
					liq = l.String()
				}
			}
		default:
			err = fmt.Errorf("unknown venue dex %q", v.Dex)
		}
		if err != nil {
			log.Printf("arbitrage %s %s price: %v", t.Symbol, v.ID, err)
			errs++
			continue
		}
		feeMul := float64(v.FeeBps) / 10000.0
		out = append(out, venueQuote{
			venue:        v,
			buy:          mid * (1 + feeMul),
			sell:         mid * (1 - feeMul),
			liq:          liq,
			reserve:      reserve,
			reserveKnown: reserveK,
		})
	}
	return out, errs
}
