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

// handleSimulateTick generates a deterministic next market snapshot for dev/testing.
// Body: {"tick_time": "...", "symbols":[{"symbol":"AAPL","price":100}, ...]}
// Prices move by a seeded random walk (0-2%) so dev seasons get realistic quotes.
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

	quotes := make([]snapshot.Quote, 0, len(req.Symbols))
	seed := req.TickTime.Unix()
	for _, sym := range req.Symbols {
		// Deterministic pseudo-random walk seeded by symbol+tick.
		h := fnv(seed, sym.Symbol)
		delta := float64(h%201-100) / 100.0 // -1.00% .. +1.00%
		price := sym.Price * (1 + delta)
		quotes = append(quotes, snapshot.Quote{
			Symbol: sym.Symbol,
			Price:  round2(price),
			Volume: float64(1_000_000 + h%2_000_000),
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
