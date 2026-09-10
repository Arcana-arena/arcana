// Command server runs the Decision Engine HTTP server.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"strconv"

	"github.com/arcana/decision-engine/internal/engine"
	"github.com/arcana/decision-engine/internal/llm"
	"github.com/arcana/internalauth"
	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
)

// buildLLM assembles the provider client from the environment.
//
// PROVIDER-AGNOSTIC ON PURPOSE. Three values identify a provider — base URL,
// model, key — and every one of them is configuration. Switching from DeepSeek
// to anything that speaks the OpenAI chat-completions shape is an env change,
// not a code change. That is not hypothetical tidiness: 'deepseek-chat' was
// named in the plan for this work and had already been retired while the plan
// was being written.
func buildLLM() *llm.Client {
	cfg := llm.Config{
		Name:        envOr("LLM_PROVIDER", "deepseek"),
		BaseURL:     envOr("LLM_BASE_URL", "https://api.deepseek.com"),
		Model:       envOr("LLM_MODEL", "deepseek-flash"),
		APIKey:      os.Getenv("LLM_API_KEY"),
		Temperature: envFloat("LLM_TEMPERATURE", 0.2),
		TopP:        envFloat("LLM_TOP_P", 0.9),
		MaxTokens:   int(envFloat("LLM_MAX_TOKENS", 700)),
		Seed:        int(envFloat("LLM_SEED", 0)),
		Timeout:     time.Duration(envFloat("LLM_TIMEOUT_MS", 30000)) * time.Millisecond,
		JSONMode:    envOr("LLM_JSON_MODE", "1") == "1",
	}
	return llm.New(cfg)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envFloat(k string, def float64) float64 {
	if v := os.Getenv(k); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
		log.Printf("WARN %s=%q is not a number; using %v", k, v, def)
	}
	return def
}

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
		port = "8081"
	}
	marketDataURL := os.Getenv("MARKET_DATA_URL")
	if marketDataURL == "" {
		marketDataURL = "http://localhost:8083"
	}

	pool, err := store.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	eng := engine.New(store.New(pool), marketdata.New(marketDataURL))

	// The LLM decider is attached only when a provider is actually configured.
	//
	// WITHOUT A KEY THE SERVICE STILL BOOTS AND STILL SERVES /healthz, and every
	// agent whose strategy_type is 'llm' RECORDS A HOLD with reason
	// llm_unavailable. It does not fall back to a deterministic strategy: an
	// agent that quietly stops being what it says it is would corrupt its own
	// track record, which is the one thing this platform sells. Same shape as
	// market-data's missing vendor key and arca-service's five warnings — a
	// stand-down that is visible, not a substitution that is not.
	client := buildLLM()
	if client.Configured() {
		eng = eng.WithLLM(engine.NewLLMDecider(client))
		log.Printf("llm decider ACTIVE: provider=%s model=%s", client.Provider(), client.Model())
	} else {
		log.Printf("WARN: llm decider INACTIVE: LLM_API_KEY not set — agents with " +
			"strategy_type='llm' will record a HOLD with reason llm_unavailable on every " +
			"tick. There is no fallback to a deterministic strategy by design: an agent " +
			"must not quietly become something other than what it declares. Deterministic " +
			"agents (momentum, mean_reversion, buy_and_hold) are unaffected.")
	}

	srv := &server{engine: eng}

	guard := internalauth.New("decision-engine")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /internal/v1/decisions/execute", guard.Wrap(srv.handleExecute))
	mux.HandleFunc("POST /internal/v1/decisions/manual", guard.Wrap(srv.handleManual))

	log.Printf("decision-engine listening on :%s", port)
	// Loopback only: layer one of the two protecting the machine tier (the
	// other is the X-Internal-Key check). Nothing here is meant to face the
	// internet directly.
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// handleExecute triggers one decision run for an agent.
func (s *server) handleExecute(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	var req engine.ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	decisionID, err := s.engine.Execute(ctx, req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "execute_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"decision_id": decisionID,
		"status":      "recorded",
	})
}

// handleManual records a human-submitted trade for a human_vs_ai session.
func (s *server) handleManual(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	var req engine.ExecuteManualRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	decisionID, err := s.engine.ExecuteManual(ctx, req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "execute_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"decision_id": decisionID,
		"status":      "recorded",
	})
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
