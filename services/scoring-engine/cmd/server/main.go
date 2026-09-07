// Command server runs the Scoring Engine HTTP server.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/arcana/scoring-engine/internal/engine"
	"github.com/arcana/scoring-engine/internal/store"
)

type server struct {
	engine *engine.Engine
}

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	pool, err := store.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	srv := &server{engine: engine.New(store.New(pool))}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /internal/v1/scoring/batch", srv.handleBatch)
	mux.HandleFunc("GET /v1/agents/{id}/score", srv.handleScore)

	log.Printf("scoring-engine listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// handleBatch runs the daily scoring batch.
func (s *server) handleBatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	res, err := s.engine.RunBatch(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "batch_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleScore returns the latest score snapshot for an agent.
func (s *server) handleScore(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agentID := r.PathValue("id")

	snap, err := s.engine.LatestScore(ctx, agentID)
	if err != nil {
		writeError(w, http.StatusNotFound, "score_not_found", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{
			"code":    errCode,
			"message": message,
			"trace_id": "",
		},
	})
}
