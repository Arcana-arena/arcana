package service

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/arcana/market-data/internal/chain"
	"github.com/arcana/market-data/internal/snapshot"
	"github.com/arcana/market-data/internal/store"
)

// SourcePool is the provenance of a snapshot whose prices came from the chain.
//
// A DISTINCT SOURCE, not a relabelled vendor snapshot. Every consumer that
// compares one tick to another scopes by source — MarketIndexService computes
// market_return within a source, Autopsy clamps its timing window to one — and
// a pool price and a vendor close are prices of different things: one is what
// a trade fills at on this chain, the other is what a US session ended at.
// Sharing a source label would make the boundary between them invisible to the
// code that exists to respect it.
const SourcePool = "robinhood_pool"

// PoolTick is the result of reading every configured pool once.
type PoolTick struct {
	Ref        string
	TickTime   time.Time
	Quotes     []snapshot.Quote
	Disputed   []string
	Unrefereed []string
	Failed     map[string]string
}

// PoolReader is the chain half of market-data.
type PoolReader struct {
	cfg    *chain.Config
	client *chain.Client
}

func NewPoolReader(cfg *chain.Config, client *chain.Client) *PoolReader {
	return &PoolReader{cfg: cfg, client: client}
}

func (p *PoolReader) Configured() bool { return p != nil && p.cfg != nil && p.client != nil }

func (p *PoolReader) Config() *chain.Config { return p.cfg }

// RefForTick names a continuous tick by the instant it was taken.
//
// Minute precision, UTC. The old ref was a TRADING DATE — one per US session,
// which is the whole assumption this phase removes. Minutes rather than
// seconds because the cadence floor is four hours: a ref that changed every
// second would imply a resolution the system does not have and cannot use.
func RefForTick(t time.Time) string {
	return "pool-" + t.UTC().Format("20060102T1504Z")
}

// Read takes one reading of every configured pool, refereed.
//
// CONCURRENT, BUT BOUNDED. Nine symbols means eighteen or more eth_calls, and
// running them one at a time against a public endpoint makes a tick take long
// enough that the prices in it are no longer contemporaneous with each other —
// which is precisely what a snapshot is supposed to be. Four at a time keeps
// the whole read inside a few seconds without hammering an endpoint that is
// doing this for free.
//
// A SYMBOL THAT CANNOT BE READ IS OMITTED AND NAMED, never zero-filled. A zero
// price is a number every downstream consumer will happily compute with.
func (p *PoolReader) Read(ctx context.Context, now time.Time) (*PoolTick, error) {
	if !p.Configured() {
		return nil, fmt.Errorf("pool reader is not configured")
	}
	tick := &PoolTick{
		Ref:      RefForTick(now),
		TickTime: now.UTC().Truncate(time.Minute),
		Failed:   map[string]string{},
	}

	type result struct {
		q       snapshot.Quote
		ok      bool
		symbol  string
		err     error
		verdict chain.Verdict
	}
	results := make([]result, len(p.cfg.Tokens))

	const concurrency = 4
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for i, t := range p.cfg.Tokens {
		wg.Add(1)
		go func(i int, t chain.TokenConfig) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			r := result{symbol: t.Symbol}
			price, err := p.client.PoolPrice(ctx, t, p.cfg.QuoteToken.Decimals)
			if err != nil {
				r.err = err
				results[i] = r
				return
			}
			feed, feedErr := p.client.FeedPrice(ctx, t.Feed)
			v := chain.Referee(p.cfg, t, price, feed, feedErr, now)

			r.verdict = v
			r.ok = true
			r.q = snapshot.Quote{
				Symbol: t.Symbol,
				Price:  round4(price),
				Sector: t.Sector,
				// Provenance travels ON THE QUOTE, not only in a log line, so a
				// snapshot pulled out of object storage years later still says
				// whether its price was refereed and by what.
				RefereeStatus: v.Status,
				RefereePrice:  round4(v.FeedPrice),
				RefereeDevPct: v.DeviationPct,
				RefereeNote:   v.Note,
				UpdatedAt:     now.UTC().Format(time.RFC3339),
			}
			if !v.FeedUpdatedAt.IsZero() {
				r.q.RefereeUpdatedAt = v.FeedUpdatedAt.Format(time.RFC3339)
			}
			results[i] = r
		}(i, t)
	}
	wg.Wait()

	for _, r := range results {
		if !r.ok {
			if r.err != nil {
				tick.Failed[r.symbol] = r.err.Error()
			} else {
				tick.Failed[r.symbol] = "no result"
			}
			continue
		}
		switch r.verdict.Status {
		case "disputed":
			tick.Disputed = append(tick.Disputed, r.symbol)
		case "unrefereed":
			tick.Unrefereed = append(tick.Unrefereed, r.symbol)
		}
		tick.Quotes = append(tick.Quotes, r.q)
	}

	if len(tick.Quotes) == 0 {
		return nil, fmt.Errorf("no pool answered: %v", tick.Failed)
	}
	return tick, nil
}

// StorePoolTick writes a pool reading as an immutable snapshot.
func (s *Service) StorePoolTick(ctx context.Context, tick *PoolTick) (*store.SnapshotRow, error) {
	return s.CreateSnapshot(ctx, IngestRequest{
		Quotes:     tick.Quotes,
		TickTime:   tick.TickTime,
		Source:     SourcePool,
		IngestMode: snapshot.ModeLive,
		FetchedAt:  time.Now().UTC(),
	}, tick.Ref)
}

func round4(v float64) float64 { return math.Round(v*10000) / 10000 }
