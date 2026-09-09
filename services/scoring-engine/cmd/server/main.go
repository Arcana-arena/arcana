// Command server runs the Scoring Engine HTTP server.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

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
	mux.HandleFunc("GET /v1/leaderboard", srv.handleLeaderboard)

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

// handleScore returns the latest score snapshot for an agent, or the history
// when from/to/granularity are supplied.
//   GET /v1/agents/:id/score                 -> latest
//   GET /v1/agents/:id/score?season_id=      -> latest within one season
//   GET /v1/agents/:id/score?from=&to=&granularity=daily -> history
//
// season_id matters now that an agent's career can span markets: Season 1 ran
// on simulator prices and Season 2 on real ones, so an unscoped history draws
// one line through two different worlds. Scoping is opt-in rather than forced
// because an agent that has only ever competed in one season needs no filter.
func (s *server) handleScore(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agentID := r.PathValue("id")
	q := r.URL.Query()
	seasonID := q.Get("season_id")

	if q.Has("from") || q.Has("to") || q.Has("granularity") {
		var from, to *time.Time
		if v := q.Get("from"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_from", "from must be RFC3339")
				return
			}
			from = &t
		}
		if v := q.Get("to"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_to", "to must be RFC3339")
				return
			}
			to = &t
		}
		daily := q.Get("granularity") == "daily"

		history, err := s.engine.ScoreHistory(ctx, agentID, seasonID, from, to, daily)
		if err != nil {
			writeError(w, http.StatusNotFound, "score_not_found", err.Error())
			return
		}
		if history == nil {
			history = []store.ScoreHistoryPoint{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_id":  agentID,
			"season_id": seasonID,
			"history":   history,
		})
		return
	}

	snap, err := s.engine.LatestScore(ctx, agentID, seasonID)
	if err != nil {
		writeError(w, http.StatusNotFound, "score_not_found", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// handleLeaderboard returns the leaderboard for a category with pagination.
// Query params: category (arcana|performance|consistency|risk|risk_adjusted|longevity),
// season_id (optional filter), page (default 1), page_size (default 20).
func (s *server) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	category := q.Get("category")
	if category == "" {
		category = "arcana"
	}
	seasonID := q.Get("season_id")
	page := atoiDefault(q.Get("page"), 1)
	pageSize := atoiDefault(q.Get("page_size"), 20)
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	entries, err := s.engine.Leaderboard(ctx, category, seasonID, page, pageSize)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_category", err.Error())
		return
	}
	if entries == nil {
		entries = []store.LeaderboardEntry{}
	}

	body := map[string]any{
		"category":  category,
		"season_id": seasonID,
		"page":      page,
		"page_size": pageSize,
		"entries":   entries,
	}

	// Label the arena when the page is filtered to one, so a Premium Arena is
	// recognisable from the leaderboard rather than only from a refused
	// registration. The tier is a fact about the season; whether the gate is
	// currently reading balances is a question about the $ARCA service, and is
	// answered by agent-service's GET /v1/seasons/{id} -- deliberately not
	// guessed at here, and not worth an outbound call from the scoring path.
	if seasonID != "" {
		season, err := s.engine.Season(ctx, seasonID)
		if err != nil {
			// Not fatal: the ranking is what was asked for. Losing the label is
			// better than losing the page.
			log.Printf("leaderboard: season %s lookup failed: %v", seasonID, err)
		} else if season != nil {
			meta := map[string]any{
				"id":          season.ID,
				"name":        season.Name,
				"access_tier": season.AccessTier,
			}
			if season.AccessTier == "premium" {
				meta["note"] = "Premium Arena: entry is gated on the $ARCA premium_arena " +
					"entitlement in addition to COMPETE. Whether that gate is currently " +
					"verifying balances is reported by GET /v1/seasons/" + season.ID +
					" on agent-service."
			}
			body["season"] = meta
		}
	}

	writeJSON(w, http.StatusOK, body)
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
			"code":    errCode,
			"message": message,
			"trace_id": "",
		},
	})
}
