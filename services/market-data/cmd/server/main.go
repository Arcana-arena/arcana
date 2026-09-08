// Command server runs the Market Data Service HTTP server.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"time"

	"github.com/arcana/market-data/internal/objectstore"
	"github.com/arcana/market-data/internal/service"
	"github.com/arcana/market-data/internal/snapshot"
	"github.com/arcana/market-data/internal/store"
)

type server struct {
	svc *service.Service
}

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}

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

	srv := &server{svc: service.New(store.New(pool), objects)}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /internal/v1/market/snapshots", srv.handleCreateSnapshot)
	mux.HandleFunc("POST /internal/v1/market/simulate/tick", srv.handleSimulateTick)
	mux.HandleFunc("GET /v1/market/snapshots/{ref}", srv.handleGetSnapshot)
	mux.HandleFunc("GET /v1/market/snapshots/{ref}/previous", srv.handlePreviousSnapshot)

	log.Printf("market-data listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// handleCreateSnapshot ingests vendor quotes and creates an immutable snapshot.
func (s *server) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req service.IngestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	// Deterministic ref from the tick time (UTC, second precision).
	ref := fmt.Sprintf("snapshot-%s", req.TickTime.UTC().Format("20060102-150405"))
	row, err := s.svc.CreateSnapshot(ctx, req, ref)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "snapshot_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"market_snapshot_ref": row.Ref,
		"content_hash":        row.ContentHash,
		"symbol_count":        row.SymbolCount,
		"tick_time":           row.TickTime.UTC().Format(time.RFC3339),
	})
}

// Simulator calibration. Tunable in one place rather than buried in the walk.
const (
	// trendBlockTicks: how many ticks a drift direction holds before it can
	// change. Ten is long enough for a trend to be worth following and short
	// enough that a 30-tick season contains about three of them, so momentum
	// and mean reversion each get their turn at being right.
	trendBlockTicks = 10
	// maxDriftPct: per-tick bias while a trend is in force (0.80% at full
	// strength). Over a block that compounds to roughly 8%.
	//
	// Calibrated against the scoring formula, not picked for realism: with
	// performance_score mapping ±20% return to 0..100, a market that moves ±1%
	// per season scores every agent at ~50 and measures nothing. A season has
	// to be able to produce real dispersion for the score to mean anything.
	maxDriftPct = 0.008
	// minDriftFraction: a trend block always commits to at least this share of
	// maxDriftPct. Drawing drift uniformly from [-max,+max] left many blocks
	// near zero, which is a flat market wearing a trend's clothing.
	minDriftFraction = 0.4
	// maxNoisePct: per-tick jitter on top of the drift (±0.60%). Comparable to
	// the drift on purpose, so a trend is never a straight line — an agent has
	// to sit through down ticks inside an uptrend.
	maxNoisePct = 0.006
	// priceFloor: prices never fall through this.
	priceFloor = 1.0
)

// handleSimulateTick generates the next market snapshot for dev/testing.
//
// The walk is a real one: each tick moves from the PREVIOUS tick's price, so
// prices accumulate instead of oscillating around whatever base the caller
// happens to send. `symbols[].price` in the body seeds only the first tick of a
// season; after that it is ignored in favour of the recorded close.
//
// Still fully deterministic, which fairness and replay depend on: every move is
// a pure function of (symbol, tick index), never of wall-clock time or call
// order, so the same history always regenerates the same market.
//
// Body: {"tick_time": "...", "symbols":[{"symbol":"AAPL","price":100}, ...]}
func (s *server) handleSimulateTick(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req struct {
		TickTime time.Time `json:"tick_time"`
		Symbols  []struct {
			Symbol string  `json:"symbol"`
			Price  float64 `json:"price"`
		} `json:"symbols"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if req.TickTime.IsZero() {
		writeError(w, http.StatusBadRequest, "invalid_request", "tick_time is required")
		return
	}
	if len(req.Symbols) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "symbols is required")
		return
	}

	// Walk forward from the LAST tick's prices, not from the caller's base
	// prices. Restarting from a constant every tick is what made the market
	// oscillate around a fixed level instead of going anywhere: it was
	// mean-reverting by construction, so a mean-reversion agent scored well for
	// matching a defect rather than for judging the market. Base prices from
	// the request now seed only the very first tick of a season.
	lastPrices, tickIndex, err := s.svc.LastPrices(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "simulate_failed", err.Error())
		return
	}

	quotes := make([]snapshot.Quote, 0, len(req.Symbols))
	for _, sym := range req.Symbols {
		base := sym.Price
		if prev, ok := lastPrices[sym.Symbol]; ok && prev > 0 {
			base = prev
		}

		// Two deterministic components. Noise alone is a martingale: it drifts
		// nowhere and any run is an accident, which gives a trend-following
		// agent nothing real to follow. The drift term holds its sign for a
		// block of ticks, so the market actually goes somewhere for a while —
		// long enough for momentum and mean reversion to be right and wrong at
		// different times, which is the whole point of scoring them.
		driftSeed := fnv(tickIndex/trendBlockTicks, sym.Symbol+"|drift")
		driftDir := 1.0
		if driftSeed&1 == 0 {
			driftDir = -1.0
		}
		driftMag := minDriftFraction + (1-minDriftFraction)*float64(driftSeed>>1%101)/100.0
		drift := driftDir * driftMag * maxDriftPct

		noiseSeed := fnv(tickIndex, sym.Symbol)
		noise := (float64(noiseSeed%201) - 100) / 100.0 * maxNoisePct

		price := base * (1 + drift + noise)
		// A simulated price must never reach zero: the portfolio maths divides
		// by it, and a season that bottoms out is unrecoverable.
		if price < priceFloor {
			price = priceFloor
		}
		quotes = append(quotes, snapshot.Quote{
			Symbol: sym.Symbol,
			Price:  round2(price),
			Volume: float64(1_000_000 + noiseSeed%2_000_000),
		})
	}

	ref := fmt.Sprintf("snapshot-%s", req.TickTime.UTC().Format("20060102-150405"))
	row, err := s.svc.CreateSnapshot(ctx, service.IngestRequest{
		TickTime: req.TickTime,
		Source:   "simulator",
		Quotes:   quotes,
	}, ref)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "simulate_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"market_snapshot_ref": row.Ref,
		"content_hash":        row.ContentHash,
		"symbol_count":        row.SymbolCount,
	})
}

// fnv is a tiny deterministic hash for reproducible simulation moves.
func fnv(seed int64, s string) uint32 {
	h := uint32(2166136261) ^ uint32(seed)
	for _, c := range s {
		h ^= uint32(c)
		h *= 16777619
	}
	return h
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
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
