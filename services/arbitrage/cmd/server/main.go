// Command server runs the ARCANA Arbitrage scanner.
//
// It is a read-only market-intelligence service: it reads configured venues,
// estimates net profit, and records opportunities. IT SIGNS AND SENDS NOTHING.
// The same-chain go/no-go (docs/go-no-go-arbitrage.md, 2026-10-18) found no
// second venue with real liquidity, so the honest output today is "indicative,
// not executable"; this service is the foundation Phase 2/3 build on.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/config"
	"github.com/arcana/arbitrage/internal/engine"
	"github.com/arcana/arbitrage/internal/store"
	"github.com/arcana/internalauth"
)

var buildCommit = "unknown"

const defaultRPC = "https://robinhood-rpc.publicnode.com," +
	"https://robinhood.api.pocket.network," +
	"https://rpc-robinhood.blockmachine.io," +
	"https://rpc.mainnet.chain.robinhood.com"

type server struct {
	engine *engine.Engine
	cfg    *config.Config
}

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8084"
	}

	allowlistFile := envOr("ARBITRAGE_ALLOWLIST_FILE", "../signer/allowlist/robinhood-mainnet.json")
	configFile := envOr("ARBITRAGE_CONFIG_FILE", "config/robinhood-arbitrage.json")

	cfg, err := config.Load(allowlistFile, configFile)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("arbitrage config: chain %d, %d tokens, min_net_profit_bps %.1f",
		cfg.ChainID, len(cfg.Tokens), cfg.MinNetProfitBps)

	rpcURLs := strings.Split(envOr("ARBITRAGE_RPC_URLS", defaultRPC), ",")
	chainClient := chain.NewClient(rpcURLs)

	pool, err := store.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	srv := &server{
		engine: engine.New(chainClient, cfg, store.New(pool)),
		cfg:    cfg,
	}

	guard := internalauth.New("arbitrage")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"arbitrage","commit":"%s"}`, buildCommit)
	})
	mux.HandleFunc("GET /v1/arbitrage/venues", srv.handleVenues)
	mux.HandleFunc("GET /v1/arbitrage/opportunities", srv.handleOpportunities)
	mux.HandleFunc("GET /v1/arbitrage/opportunities/history", srv.handleHistory)
	mux.HandleFunc("POST /internal/v1/arbitrage/scan", guard.Wrap(srv.handleScan))

	// The continuous scanner. Disabled by an empty or invalid SCAN_INTERVAL, so
	// the service can run as a pure HTTP API (or under a systemd timer) without
	// a background loop when that is the operator's choice.
	if d := scanInterval(); d > 0 {
		go srv.runScanner(d)
	} else {
		log.Printf("arbitrage background scanner DISABLED (SCAN_INTERVAL=%q)", os.Getenv("SCAN_INTERVAL"))
	}

	log.Printf("arbitrage listening on :%s", port)
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func (s *server) handleVenues(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg)
}

func (s *server) handleOpportunities(w http.ResponseWriter, r *http.Request) {
	rows, err := s.engine.Latest(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "opportunities_unavailable", err.Error())
		return
	}
	if rows == nil {
		rows = []store.OpportunityRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"opportunities": rows})
}

func (s *server) handleHistory(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.engine.Recent(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "history_unavailable", err.Error())
		return
	}
	if rows == nil {
		rows = []store.OpportunityRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"opportunities": rows})
}

func (s *server) handleScan(w http.ResponseWriter, r *http.Request) {
	res, err := s.engine.ScanOnce(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "scan_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) runScanner(d time.Duration) {
	log.Printf("arbitrage background scanner started (interval %s)", d)
	// Scan immediately so a fresh scanner has a heartbeat and rows without
	// waiting a full interval.
	s.scanNow()
	t := time.NewTicker(d)
	defer t.Stop()
	for range t.C {
		s.scanNow()
	}
}

func (s *server) scanNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	res, err := s.engine.ScanOnce(ctx)
	if err != nil {
		log.Printf("arbitrage scan: %v", err)
		return
	}
	log.Printf("arbitrage scan: %d opportunities, %d errors", res.Opportunities, res.Errors)
}

func scanInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("SCAN_INTERVAL"))
	if v == "" {
		return 60 * time.Second
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0
	}
	return d
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
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
