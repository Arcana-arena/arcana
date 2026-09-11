// Command server runs the Decision Engine HTTP server.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/arcana/decision-engine/internal/engine"
	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/llm"
	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
	"github.com/arcana/internalauth"
)

// buildCommit is stamped at link time by infra/systemd/install.sh:
//   go build -ldflags "-X main.buildCommit=$(git rev-parse HEAD)"
//
// WHY A SERVICE REPORTS ITS OWN VERSION. These used to run under `go run`,
// which recompiled on every restart, so restarting was the same as deploying.
// Running a built binary is faster and cleaner but breaks that: `git pull &&
// systemctl restart` silently keeps running the old code, with nothing to
// show for it. That trap was found in this repo the day the signer was
// installed — a preflight change simply did not appear, and the only clue was
// a log line that never printed.
//
// So the binary carries the commit it was built from and says so on /healthz,
// and infra/verify/deployed-version-verify.sh compares that against the
// checked-out HEAD. A stale deploy becomes something that reports itself.
var buildCommit = "unknown"

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
		// XIAOMI MiMo since 2026-09-11. The defaults name the provider this
		// platform actually has an account with — a default pointing at one it
		// does not would be a default that cannot work, which is worse than no
		// default because it looks configured.
		//
		// VERIFIED BY EXECUTION before being written here, not taken from
		// documentation: /v1/models returned the model list, and a
		// chat-completion with response_format=json_object came back as valid
		// JSON carrying usage and finish_reason — the exact shape this engine
		// sends and parses.
		//
		// No /v1 on the base URL: the client appends /v1/chat/completions.
		Name:        envOr("LLM_PROVIDER", "mimo"),
		BaseURL:     envOr("LLM_BASE_URL", "https://api.xiaomimimo.com"),
		// mimo-v2.5 rather than mimo-v2.5-pro. The switch away from DeepSeek was
		// about cost, so the cheaper model is the default; -pro is one variable
		// away and needs no code change, which is the whole point of this shape.
		Model:       envOr("LLM_MODEL", "mimo-v2.5"),
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

// buildBroker returns the broker, or nil when chain execution is switched off.
//
// It returns an ERROR when some of the configuration is present and some is
// not, because that is the shape a half-finished deploy takes and it must not
// look like the off switch.
func buildBroker() (*execution.Broker, error) {
	signerURL := os.Getenv("SIGNER_URL")
	internalKey := os.Getenv("INTERNAL_API_KEY")
	allowlist := os.Getenv("EXECUTION_ALLOWLIST_FILE")
	rpcs := os.Getenv("EXECUTION_RPC_URLS")

	// INTERNAL_API_KEY IS NOT COUNTED. Every service needs it for the internal
	// tier, so it is set on hosts and in test rigs that have no chain execution
	// at all -- counting it made this look like a half-finished deploy and the
	// service refused to start. decider-verify, which spawns its own engine with
	// the key and nothing else, found that within the hour.
	//
	// It is still required WHEN the other three are present, because the signer
	// will not answer without it.
	set := 0
	for _, v := range []string{signerURL, allowlist, rpcs} {
		if v != "" {
			set++
		}
	}
	if set == 0 {
		return nil, nil
	}
	if set < 3 {
		return nil, fmt.Errorf(
			"SIGNER_URL, EXECUTION_ALLOWLIST_FILE and EXECUTION_RPC_URLS must all be set or all be "+
				"empty; %d of 3 are set", set)
	}
	if internalKey == "" {
		return nil, fmt.Errorf(
			"chain execution is configured but INTERNAL_API_KEY is not set, so the signer would "+
				"refuse every request")
	}

	cfg, err := execution.LoadConfig(allowlist)
	if err != nil {
		return nil, err
	}
	urls := strings.Split(rpcs, ",")
	for i := range urls {
		urls[i] = strings.TrimSpace(urls[i])
	}
	rpc := execution.NewRPC(urls, 20*time.Second)
	signer := execution.NewSignerClient(signerURL, internalKey, execution.HTTPClient(120*time.Second))
	b := execution.NewBroker(cfg, rpc, signer)
	if v := envFloat("EXECUTION_SLIPPAGE_BPS", 0); v > 0 {
		b.SlippageBps = int64(v)
	}
	log.Printf("execution allowlist: chain %d, %d tokens, router %s, slippage %d bps",
		cfg.ChainID, len(cfg.Tokens), cfg.Router(), b.SlippageBps)
	return b, nil
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
	engine         *engine.Engine
	executeTimeout time.Duration
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


	// Chain execution is attached only when all three of its pieces are present.
	//
	// PARTIAL CONFIGURATION IS REFUSED RATHER THAN DEGRADED. Two of the three
	// would let the service boot into a state where an agent has a wallet and no
	// way to trade from it, and the symptom would be a portfolio drifting
	// further from its own funds every tick. Missing all three is a different
	// thing entirely and is fine: no agent has a wallet, and nothing has
	// changed from the way every season has run so far.
	if b, err := buildBroker(); err != nil {
		log.Fatalf("FATAL chain execution is partly configured: %v", err)
	} else if b != nil {
		eng = eng.WithBroker(b)
		log.Printf("chain execution ACTIVE: agents holding a wallet settle on chain")
	} else {
		log.Printf("chain execution INACTIVE: no signer/RPC/allowlist configured. Agents " +
			"WITHOUT a wallet settle against snapshot prices as before; an agent WITH a " +
			"wallet is refused rather than settled virtually.")
	}

		// HOW LONG ONE CYCLE MAY TAKE.
	//
	// Fifteen seconds was right when a cycle was: read state, decide, do
	// arithmetic, insert a row. A chain-backed cycle reads ten balances, may
	// send an approval, sends a swap, and WAITS FOR TWO RECEIPTS. The old
	// deadline expired mid-cycle and surfaced as "append decision: context
	// deadline exceeded" — a timeout message for a limit that had nothing to do
	// with the database.
	//
	// It is raised only when chain execution is actually attached, so a purely
	// virtual deployment keeps the tight bound that suits it.
	executeTimeout := 15 * time.Second
	if eng.HasBroker() {
		executeTimeout = 4 * time.Minute
	}
	srv := &server{engine: eng, executeTimeout: executeTimeout}

	guard := internalauth.New("decision-engine")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"decision-engine","commit":"%s"}`, buildCommit)
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
	ctx, cancel := context.WithTimeout(r.Context(), s.executeTimeout)
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
	ctx, cancel := context.WithTimeout(r.Context(), s.executeTimeout)
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
