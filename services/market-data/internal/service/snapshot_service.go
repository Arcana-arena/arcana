package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"time"

	"github.com/arcana/market-data/internal/objectstore"
	"github.com/arcana/market-data/internal/session"
	"github.com/arcana/market-data/internal/snapshot"
	"github.com/arcana/market-data/internal/store"
	"github.com/arcana/market-data/internal/universe"
	"github.com/arcana/market-data/internal/vendor"
)

// IngestRequest is the normalized payload a snapshot is built from.
type IngestRequest struct {
	TickTime    time.Time        `json:"tick_time"`
	Source      string           `json:"source"`
	IngestMode  string           `json:"ingest_mode"`
	TradingDate *time.Time       `json:"trading_date"`
	FetchedAt   time.Time        `json:"fetched_at"`
	Quotes      []snapshot.Quote `json:"quotes"`
}

// Service coordinates snapshot creation: object storage + DB ref.
type Service struct {
	store    *store.Store
	objects  *objectstore.Client
	vendor   *vendor.Client
	universe *universe.Universe
	eastern  *time.Location
}

func New(st *store.Store, objs *objectstore.Client, v *vendor.Client, u *universe.Universe, et *time.Location) *Service {
	return &Service{store: st, objects: objs, vendor: v, universe: u, eastern: et}
}

// VendorConfigured reports whether prices can actually be read.
func (s *Service) VendorConfigured() bool { return s.vendor.Configured() }

// Universe exposes the loaded symbol list.
func (s *Service) Universe() *universe.Universe { return s.universe }

// VendorName is the source recorded on snapshots this service creates.
func (s *Service) VendorName() string { return s.vendor.Name() }

// FetchResult describes the outcome of a session fetch.
type FetchResult struct {
	Row     *store.SnapshotRow
	Created bool // false when the snapshot already existed (an idempotent retry)
}

// minUniverseCoverage is the fraction of the universe that must be priced for a
// snapshot to be accepted.
//
// A grouped daily response covers the whole market, so a handful of our fifty
// names missing means something is wrong with the response, not with those
// companies. Accepting a partial snapshot would silently change the universe
// for that session — agents would be scored on a different opportunity set
// than the one the season declares — and nothing downstream could tell.
// Rejecting is the honest failure: no tick, loud log, competition paused.
const minUniverseCoverage = 0.95

// FetchSession fetches one trading session and stores it as an immutable
// snapshot.
//
// Idempotent on (source, trading_date): if the session is already stored it is
// returned with Created=false and NO vendor request is made. That is what lets
// the 01:00 and 03:00 UTC retries be unconditional — they recover a failed
// 23:00 run and cost nothing after a successful one.
//
// Returns vendor.ErrMarketClosed when the session did not exist. The caller
// must treat that as "no tick today", not as a failure.
func (s *Service) FetchSession(ctx context.Context, date time.Time, mode string) (*FetchResult, error) {
	if !s.vendor.Configured() {
		return nil, vendor.ErrNotConfigured
	}
	if mode != snapshot.ModeLive && mode != snapshot.ModeBackfill {
		return nil, fmt.Errorf("invalid ingest mode %q", mode)
	}

	existing, err := s.store.FindByTradingDate(ctx, s.vendor.Name(), date)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return &FetchResult{Row: existing, Created: false}, nil
	}

	// A weekend is knowable without spending one of five requests per minute.
	// Holidays are not, so they go to the vendor.
	if session.IsWeekend(date) {
		return nil, vendor.ErrMarketClosed
	}

	fetchedAt := time.Now().UTC()
	bars, err := s.vendor.GroupedDaily(ctx, date)
	if err != nil {
		return nil, err
	}

	quotes, err := s.toQuotes(bars, date)
	if err != nil {
		return nil, err
	}

	// tick_time is the session's close in UTC, not the moment the job ran.
	// Anchoring it to the session keeps the series ordered by market time, so a
	// backfilled snapshot sorts into its correct place rather than at the end.
	tickTime := s.sessionClose(date)
	d := date
	req := IngestRequest{
		TickTime:    tickTime,
		Source:      s.vendor.Name(),
		IngestMode:  mode,
		TradingDate: &d,
		FetchedAt:   fetchedAt,
		Quotes:      quotes,
	}

	row, err := s.CreateSnapshot(ctx, req, RefForSession(date))
	if err != nil {
		return nil, err
	}
	return &FetchResult{Row: row, Created: true}, nil
}

// RefForSession is the stable public id for a session's snapshot.
//
// Derived from the TRADING DATE, not from wall-clock time: that is what makes
// the ref identical across the 23:00/01:00/03:00 runs and therefore what makes
// the retries idempotent. The old simulator derived it from the moment of the
// call, so two runs about the same session produced two snapshots.
func RefForSession(date time.Time) string {
	return "snapshot-" + date.Format("20060102") + "-eod"
}

// sessionClose is 16:00 US Eastern on the session date, expressed in UTC.
func (s *Service) sessionClose(date time.Time) time.Time {
	return time.Date(date.Year(), date.Month(), date.Day(), 16, 0, 0, 0, s.eastern).UTC()
}

// toQuotes filters the market-wide response down to the universe and validates
// it.
//
// Every rejection here is a case where accepting would put a number that is not
// a price into evidence. A zero or negative close breaks the portfolio maths
// (which divides by price); a close outside its own session's low/high means
// the response is internally inconsistent and cannot be trusted for the rest of
// the row either.
func (s *Service) toQuotes(bars []vendor.Bar, date time.Time) ([]snapshot.Quote, error) {
	bySymbol := make(map[string]vendor.Bar, len(bars))
	for _, b := range bars {
		if s.universe.Has(b.Symbol) {
			bySymbol[b.Symbol] = b
		}
	}

	quotes := make([]snapshot.Quote, 0, s.universe.Size())
	var missing, rejected []string
	for _, m := range s.universe.Symbols {
		b, ok := bySymbol[m.Symbol]
		if !ok {
			missing = append(missing, m.Symbol)
			continue
		}
		if err := validateBar(b); err != nil {
			rejected = append(rejected, fmt.Sprintf("%s (%v)", m.Symbol, err))
			continue
		}
		quotes = append(quotes, snapshot.Quote{
			Symbol:    b.Symbol,
			Price:     round2(b.Close),
			Volume:    b.Volume,
			Sector:    m.Sector,
			Open:      round2(b.Open),
			High:      round2(b.High),
			Low:       round2(b.Low),
			VWAP:      round2(b.VWAP),
			Trades:    b.Trades,
			UpdatedAt: date.Format("2006-01-02"),
		})
	}

	// Deterministic order, so the payload hash depends on the prices rather than
	// on map iteration order.
	sort.Slice(quotes, func(i, j int) bool { return quotes[i].Symbol < quotes[j].Symbol })

	if len(rejected) > 0 {
		log.Printf("market-data: %s rejected %d implausible quote(s): %v",
			date.Format("2006-01-02"), len(rejected), rejected)
	}
	if len(missing) > 0 {
		log.Printf("market-data: %s missing %d universe symbol(s) from the vendor response: %v",
			date.Format("2006-01-02"), len(missing), missing)
	}

	coverage := float64(len(quotes)) / float64(s.universe.Size())
	if coverage < minUniverseCoverage {
		return nil, fmt.Errorf(
			"vendor response for %s covers only %d of %d universe symbols (%.1f%%, minimum %.0f%%); "+
				"refusing to build a snapshot on a partial universe — missing: %v; rejected: %v",
			date.Format("2006-01-02"), len(quotes), s.universe.Size(), coverage*100,
			minUniverseCoverage*100, missing, rejected)
	}
	return quotes, nil
}

func validateBar(b vendor.Bar) error {
	if b.Close <= 0 {
		return errors.New("close is not positive")
	}
	if math.IsNaN(b.Close) || math.IsInf(b.Close, 0) {
		return errors.New("close is not a finite number")
	}
	if b.Low > 0 && b.High > 0 {
		if b.Close < b.Low || b.Close > b.High {
			return fmt.Errorf("close %.2f outside session range %.2f-%.2f", b.Close, b.Low, b.High)
		}
	}
	return nil
}

// CreateSnapshot normalizes quotes into an immutable snapshot and records its ref.
func (s *Service) CreateSnapshot(ctx context.Context, req IngestRequest, ref string) (*store.SnapshotRow, error) {
	if len(req.Quotes) == 0 {
		return nil, fmt.Errorf("no quotes provided")
	}
	if req.TickTime.IsZero() {
		req.TickTime = time.Now().UTC()
	}
	if req.Source == "" {
		req.Source = "unknown"
	}
	if req.IngestMode == "" {
		req.IngestMode = snapshot.ModeLive
	}
	if req.FetchedAt.IsZero() {
		req.FetchedAt = time.Now().UTC()
	}

	prov := &snapshot.Provenance{
		Source:     req.Source,
		IngestMode: req.IngestMode,
		FetchedAt:  req.FetchedAt,
	}
	if req.TradingDate != nil {
		prov.TradingDate = req.TradingDate.Format("2006-01-02")
	}
	if s.universe != nil {
		prov.UniverseName = s.universe.Name
	}

	snap := snapshot.Snapshot{
		Ref:        ref,
		TickTime:   req.TickTime,
		Symbols:    req.Quotes,
		Source:     req.Source,
		Provenance: prov,
	}

	payload, err := json.Marshal(snap)
	if err != nil {
		return nil, fmt.Errorf("marshal snapshot: %w", err)
	}

	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])

	key := fmt.Sprintf("market/%s.json", ref)
	if err := s.objects.Put(ctx, key, payload); err != nil {
		return nil, err
	}

	row := &store.SnapshotRow{
		Ref:         ref,
		TickTime:    snap.TickTime,
		ObjectKey:   key,
		ContentHash: hash,
		SymbolCount: len(snap.Symbols),
		Status:      "stored",
		Source:      req.Source,
		IngestMode:  req.IngestMode,
		TradingDate: req.TradingDate,
		FetchedAt:   &req.FetchedAt,
	}
	if err := s.store.InsertSnapshot(ctx, row); err != nil {
		return nil, err
	}
	return row, nil
}

// GetSnapshot returns the immutable payload for a ref.
func (s *Service) GetSnapshot(ctx context.Context, ref string) ([]byte, error) {
	row, err := s.store.LookupByRef(ctx, ref)
	if err != nil {
		return nil, err
	}
	return s.objects.Get(ctx, row.ObjectKey)
}

// SnapshotRow exposes the indexed row (provenance included) for a ref.
func (s *Service) SnapshotRow(ctx context.Context, ref string) (*store.SnapshotRow, error) {
	return s.store.LookupByRef(ctx, ref)
}

// PreviousSnapshot returns the payload of the snapshot immediately preceding
// ref, from the same source. The second return value is false when ref is the
// first snapshot on record — a caller on the very first tick has no prior
// prices, which is a normal state, not an error.
func (s *Service) PreviousSnapshot(ctx context.Context, ref string) ([]byte, bool, error) {
	prev, err := s.store.PreviousRef(ctx, ref)
	if err != nil {
		return nil, false, err
	}
	if prev == "" {
		return nil, false, nil
	}
	payload, err := s.GetSnapshot(ctx, prev)
	if err != nil {
		return nil, false, err
	}
	return payload, true, nil
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
