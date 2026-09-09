// Command server runs the Market Data Service HTTP server.
//
// This service READS the market; it does not invent it. The price simulator
// that used to live here was removed in the vendor switchover: it generated a
// deterministic random walk whose trend behaviour ARCANA calibrated itself,
// which meant every score, DNA fingerprint and Autopsy finding measured the
// simulator as much as the agent. Two defects proved the point — an unsigned
// underflow that quoted AAPL at 4.7 billion, and a walk that was mean-reverting
// by construction so a mean-reversion agent won for matching a bug. Real prices
// cannot fail in those ways.
//
// There is deliberately NO fallback generator. If the vendor cannot be read,
// no snapshot is created and no tick opens. See docs/market-data.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/arcana/market-data/internal/objectstore"
	"github.com/arcana/market-data/internal/service"
	"github.com/arcana/market-data/internal/session"
	"github.com/arcana/market-data/internal/snapshot"
	"github.com/arcana/market-data/internal/store"
	"github.com/arcana/internalauth"
	"github.com/arcana/market-data/internal/universe"
	"github.com/arcana/market-data/internal/vendor"
)

type server struct {
	svc     *service.Service
	eastern *time.Location
}

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := envOr("PORT", "8083")

	pool, err := store.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	objCfg := objectstore.Config{
		Endpoint:     envOr("S3_ENDPOINT", "http://localhost:9000"),
		Region:       envOr("S3_REGION", "us-east-1"),
		AccessKey:    envOr("S3_ACCESS_KEY", "arcana"),
		SecretKey:    envOr("S3_SECRET_KEY", "arcana-secret"),
		Bucket:       envOr("S3_BUCKET", "arcana-market"),
		UsePathStyle: true,
	}
	objects, err := objectstore.New(ctx, objCfg)
	if err != nil {
		log.Fatalf("connect object store: %v", err)
	}

	// The universe is a rule of the competition, so a missing or malformed file
	// is fatal rather than defaulted. Silently falling back to some built-in
	// list would change what every season measures without anyone deciding to.
	universePath := envOr("MARKET_UNIVERSE_FILE", "universe/us-large-cap-50.json")
	uni, err := universe.Load(universePath)
	if err != nil {
		log.Fatalf("load universe: %v", err)
	}

	eastern, err := session.Eastern()
	if err != nil {
		log.Fatalf("load US Eastern timezone (needed to resolve trading sessions): %v", err)
	}

	vendorClient := vendor.New(vendor.Config{
		BaseURL: envOr("MARKET_VENDOR_BASE_URL", "https://api.polygon.io"),
		APIKey:  os.Getenv("MARKET_VENDOR_API_KEY"),
		Name:    envOr("MARKET_VENDOR_NAME", "polygon"),
	})

	srv := &server{
		svc:     service.New(store.New(pool), objects, vendorClient, uni, eastern),
		eastern: eastern,
	}

	// Same loudness as arca-service's five boot warnings: the state of a feature
	// that cannot run has to be visible in the journal, not inferred from a
	// config file. Note what it does NOT do — fall back to the simulator. A
	// competition that pauses is recoverable; agents scored against invented
	// prices are not.
	if vendorClient.Configured() {
		log.Printf("market data vendor ACTIVE: %s, universe %q (%d symbols, %d sectors)",
			vendorClient.Name(), uni.Name, uni.Size(), len(uni.Sectors()))
	} else {
		log.Printf("WARN: market data vendor INACTIVE: MARKET_VENDOR_API_KEY not set — "+
			"no snapshot can be fetched and NO TICK WILL OPEN. There is no fallback "+
			"price generator by design (see docs/market-data.md). Universe %q loaded "+
			"(%d symbols) and waiting.", uni.Name, uni.Size())
	}

	guard := internalauth.New("market-data")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /v1/market/universe", srv.handleUniverse)
	mux.HandleFunc("GET /v1/market/session/expected", srv.handleExpectedSession)
	mux.HandleFunc("POST /internal/v1/market/sessions/daily", guard.Wrap(srv.handleDailySession))
	mux.HandleFunc("POST /internal/v1/market/sessions/backfill", guard.Wrap(srv.handleBackfill))
	mux.HandleFunc("GET /v1/market/snapshots/{ref}", srv.handleGetSnapshot)
	mux.HandleFunc("GET /v1/market/snapshots/{ref}/previous", srv.handlePreviousSnapshot)
	mux.HandleFunc("POST /internal/v1/market/snapshots/prices", guard.Wrap(srv.handlePriceLookup))

	log.Printf("market-data listening on :%s", port)
	// Loopback only: layer one of the two protecting the machine tier (the
	// other is the X-Internal-Key check). Nothing here is meant to face the
	// internet directly.
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// handleUniverse exposes the loaded symbol list, so a client can see which
// symbols a season trades and each one's sector without reading the repo.
func (s *server) handleUniverse(w http.ResponseWriter, _ *http.Request) {
	u := s.svc.Universe()
	writeJSON(w, http.StatusOK, map[string]any{
		"name":         u.Name,
		"description":  u.Description,
		"sector_scheme": u.SectorScheme,
		"size":         u.Size(),
		"sectors":      u.Sectors(),
		"symbols":      u.Symbols,
	})
}

// handleDailySession fetches the most recent completed trading session.
//
// Takes NO date parameter, and that is the structural half of the
// backfill/replay rule: the production path is incapable of asking for a
// historical session, so a scored season cannot be replayed over dates whose
// outcome is already known. Backfill is a separate endpoint that marks what it
// writes.
//
// Three distinct outcomes, because they need three different responses from the
// caller:
//
//	201 created    — a new snapshot; open a tick on it
//	200 exists     — already fetched (an idempotent retry); do not re-tick
//	204 no session — market closed; no tick at all, and this is NOT an error
//	5xx            — could not find out; no tick, and somebody must look
func (s *server) handleDailySession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	date := session.LastCompleted(time.Now().UTC(), s.eastern)

	res, err := s.svc.FetchSession(ctx, date, snapshot.ModeLive)
	if err != nil {
		s.writeFetchError(w, date, err)
		return
	}

	code := http.StatusOK
	if res.Created {
		code = http.StatusCreated
	}
	writeJSON(w, code, sessionResponse(res, date))
}

// handleBackfill fetches ONE historical session and marks it ingest_mode
// 'backfill'.
//
// Backfilled snapshots are real prices and are wanted: they give /previous
// something to compare against, and Agent DNA depth it would otherwise wait
// months for. What they must never do is carry a scored decision — the outcome
// was already knowable when they were fetched, so a season run over them is a
// backtest, and §5's "decisions recorded before the outcome is known" would
// quietly stop being true. agent-service enforces that by refusing to open a
// tick on a backfill snapshot.
//
// Body: {"date": "2026-09-08"}
func (s *server) handleBackfill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req struct {
		Date string `json:"date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	date, err := time.ParseInLocation("2006-01-02", req.Date, s.eastern)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "date must be YYYY-MM-DD: "+err.Error())
		return
	}
	if !date.Before(session.LastCompleted(time.Now().UTC(), s.eastern).AddDate(0, 0, 1)) {
		writeError(w, http.StatusBadRequest, "invalid_request",
			"backfill is for past sessions; use the daily endpoint for the current one")
		return
	}

	res, err := s.svc.FetchSession(ctx, date, snapshot.ModeBackfill)
	if err != nil {
		s.writeFetchError(w, date, err)
		return
	}
	code := http.StatusOK
	if res.Created {
		code = http.StatusCreated
	}
	writeJSON(w, code, sessionResponse(res, date))
}

func sessionResponse(res *service.FetchResult, date time.Time) map[string]any {
	return map[string]any{
		"market_snapshot_ref": res.Row.Ref,
		"content_hash":        res.Row.ContentHash,
		"symbol_count":        res.Row.SymbolCount,
		"trading_date":        date.Format("2006-01-02"),
		"tick_time":           res.Row.TickTime.UTC().Format(time.RFC3339),
		"source":              res.Row.Source,
		"ingest_mode":         res.Row.IngestMode,
		"created":             res.Created,
	}
}

// writeFetchError keeps "there was no trading day" separate from "we could not
// find out". Collapsing them would let an outage look like a public holiday,
// and a competition would sit idle looking healthy.
func (s *server) writeFetchError(w http.ResponseWriter, date time.Time, err error) {
	switch {
	case errors.Is(err, vendor.ErrMarketClosed):
		log.Printf("market-data: no session on %s (market closed) — no snapshot, no tick",
			date.Format("2006-01-02"))
		w.Header().Set("X-Market-Status", "closed")
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, vendor.ErrNotConfigured):
		log.Printf("ERROR market-data: cannot fetch %s — MARKET_VENDOR_API_KEY is not set. "+
			"No snapshot, no tick. There is no fallback price source by design.",
			date.Format("2006-01-02"))
		writeError(w, http.StatusServiceUnavailable, "vendor_not_configured", err.Error())
	default:
		log.Printf("ERROR market-data: could not fetch session %s: %v — no snapshot, no tick. "+
			"The competition stays paused until this is resolved; prices are never substituted.",
			date.Format("2006-01-02"), err)
		writeError(w, http.StatusBadGateway, "vendor_unavailable", err.Error())
	}
}

// handleGetSnapshot returns the immutable payload for a ref.
func (s *server) handleGetSnapshot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ref := r.PathValue("ref")

	payload, err := s.svc.GetSnapshot(ctx, ref)
	if err != nil {
		writeError(w, http.StatusNotFound, "snapshot_not_found", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// handlePreviousSnapshot returns the snapshot immediately preceding a ref, so
// strategies can see which way prices moved. 204 when ref is the first
// snapshot on record — no prior tick is a normal state, not an error.
func (s *server) handlePreviousSnapshot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ref := r.PathValue("ref")

	payload, found, err := s.svc.PreviousSnapshot(ctx, ref)
	if err != nil {
		writeError(w, http.StatusNotFound, "snapshot_not_found", err.Error())
		return
	}
	if !found {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{
			"code":     errCode,
			"message":  message,
			"trace_id": "",
		},
	})
}

// handlePriceLookup resolves a batch of snapshot refs to their prices.
//
// Machine tier: it exists so agent-service can attach the price behind every
// decision in one upstream call instead of one call per row. Refs that cannot
// be read come back in "missing" rather than being dropped -- a trade rendered
// without a price, when a price was expected, is a quiet lie.
func (s *server) handlePriceLookup(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var req struct {
		Refs    []string `json:"refs"`
		Symbols []string `json:"symbols"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	snapshots, missing, err := s.svc.LookupPrices(ctx, req.Refs, req.Symbols)
	if err != nil {
		writeError(w, http.StatusBadRequest, "price_lookup_failed", err.Error())
		return
	}
	if missing == nil {
		missing = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"snapshots": snapshots,
		"missing":   missing,
	})
}

// handleExpectedSession reports which trading session SHOULD be the most
// recent completed one, and nothing else.
//
// It exists so the tick watchdog does not compute that date a second time.
// There is already one authority for it -- session.LastCompleted, the same
// function the daily fetch uses -- and a monitor that reimplemented the rule
// would eventually disagree with the thing it monitors, which is worse than no
// monitor at all.
//
// STRICTLY READ-ONLY. The obvious alternative, calling
// POST /internal/v1/market/sessions/daily, would FETCH from the vendor and
// create a snapshot: a monitor must never mutate what it observes.
//
// Weekends are answered structurally by PreviousWeekday. HOLIDAYS ARE NOT
// ANSWERED HERE -- they are the vendor is job, and the evidence that a date was
// a trading day is a stored snapshot carrying that trading_date. This endpoint
// says which date to ask about, never whether the market opened.
func (s *server) handleExpectedSession(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	date := session.LastCompleted(now, s.eastern)
	writeJSON(w, http.StatusOK, map[string]any{
		"trading_date":       date.Format("2006-01-02"),
		"asked_at":           now.Format(time.RFC3339),
		"today_is_weekend":   session.IsWeekend(now.In(s.eastern)),
		"holidays_determined_by": "vendor",
	})
}
