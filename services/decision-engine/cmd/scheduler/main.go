// Command scheduler advances one competition by one tick.
//
// Designed to be invoked by a systemd timer at 23:00 UTC with idempotent
// retries at 01:00 and 03:00 UTC. Three modes:
//
//	Phase 0 (no session): the market was closed, or its snapshot already carried
//	  a tick. Nothing happens and the exit code is 0 — a day with no trading is
//	  not a failure.
//	Phase 1 (new session): fetch the day's snapshot -> open tick -> run every AI
//	  participant. With human participants and -human-window > 0 the tick is
//	  LEFT OPEN so humans can submit; otherwise it is closed immediately.
//	Phase 2 (open tick exists): once window_start + human-window has elapsed,
//	  close the tick; if still inside the window, exit without doing anything.
//
// WHAT CHANGED WITH REAL PRICES. This used to call a simulator with two
// hardcoded base prices and always got a snapshot back, so a tick always
// opened — including at 03:00 on a Sunday, when agents "traded" a market that
// had not moved because nothing was moving it. Now the snapshot comes from the
// vendor, and there are days when there is no snapshot to be had. A closed
// market means NO TICK AT ALL rather than a tick flagged as closed: a tick that
// does not exist needs no exclusion logic in scoring, DNA, Autopsy, the
// Passport or the leaderboard, and the first consumer to forget such a flag
// would score an agent on a frozen price.
//
// Usage: scheduler -competition <id> [-human-window 1h]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"os"
	"time"
)

type config struct {
	agentServiceURL   string
	decisionEngineURL string
	marketDataURL     string
	scoringURL        string
}

type competition struct {
	ID             string   `json:"id"`
	SeasonID       string   `json:"seasonId"`
	Type           string   `json:"type"`
	ParticipantIDs []string `json:"participantIds"`
	Status         string   `json:"status"`
}

type openTick struct {
	ID                string     `json:"id"`
	TickIndex         int        `json:"tickIndex"`
	Phase             string     `json:"phase"`
	MarketSnapshotRef string     `json:"marketSnapshotRef"`
	WindowStart       *time.Time `json:"windowStart"`
	WindowEnd         *time.Time `json:"windowEnd"`
}

type sessionResult struct {
	Ref         string `json:"market_snapshot_ref"`
	TradingDate string `json:"trading_date"`
	Source      string `json:"source"`
	IngestMode  string `json:"ingest_mode"`
	Created     bool   `json:"created"`
	SymbolCount int    `json:"symbol_count"`
}

func main() {
	compID := flag.String("competition", "", "competition id to advance")
	humanWindow := flag.Duration("human-window", 0, "how long an open tick waits for human submissions before closing (e.g. 1h)")
	flag.Parse()
	if *compID == "" {
		log.Fatal("-competition is required")
	}

	cfg := config{
		agentServiceURL:   envOr("AGENT_SERVICE_URL", "http://localhost:3001"),
		decisionEngineURL: envOr("DECISION_ENGINE_URL", "http://localhost:8081"),
		marketDataURL:     envOr("MARKET_DATA_URL", "http://localhost:8083"),
		scoringURL:        envOr("SCORING_URL", "http://localhost:8082"),
	}

	ctx := context.Background()
	now := time.Now().UTC()

	comp, err := getCompetition(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("load competition: %v", err)
	}
	if comp.Status == "completed" {
		log.Printf("competition %s already completed; nothing to do", *compID)
		return
	}

	hasHuman := false
	for _, pid := range comp.ParticipantIDs {
		if isHuman, err := agentIsHuman(ctx, cfg, pid); err == nil && isHuman {
			hasHuman = true
			break
		}
	}

	open, err := getOpenTick(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("get open tick: %v", err)
	}

	if open != nil && open.ID != "" {
		// Phase 2: an open tick exists — close it once the human window elapsed.
		if open.WindowStart != nil && *humanWindow > 0 {
			deadline := open.WindowStart.Add(*humanWindow)
			if now.Before(deadline) {
				log.Printf("tick %d still in human window until %s; nothing to do", open.TickIndex, deadline.Format(time.RFC3339))
				return
			}
		}
		if err := closeTick(ctx, cfg, *compID); err != nil {
			log.Fatalf("close tick: %v", err)
		}
		log.Printf("tick %d closed for %s", open.TickIndex, *compID)
		return
	}

	// Phase 0/1: no open tick — ask for today's session.
	//
	// Deliberately takes no date: the production path CANNOT request a
	// historical session, so a scored season cannot be replayed over dates whose
	// outcome is already known.
	sess, status, err := fetchDailySession(ctx, cfg)
	if err != nil {
		// A vendor failure is loud and non-zero. No snapshot means no tick, and
		// no substitute price is ever generated — a paused competition is
		// recoverable, an agent scored against an invented price is not.
		log.Fatalf("ERROR: could not obtain today's market snapshot: %v — no tick opened, competition paused", err)
	}
	if status == http.StatusNoContent {
		log.Printf("market closed today; no session, no tick for %s", *compID)
		return
	}

	// An idempotent retry: the 23:00 run already stored this session. Check
	// whether it also already carried a tick, so 01:00 and 03:00 confirm rather
	// than duplicate.
	if !sess.Created {
		used, err := tickExistsForRef(ctx, cfg, *compID, sess.Ref)
		if err != nil {
			log.Fatalf("check existing ticks: %v", err)
		}
		if used {
			log.Printf("session %s (%s) already ticked for %s; nothing to do",
				sess.TradingDate, sess.Ref, *compID)
			return
		}
	}

	log.Printf("session %s: %s (%s, %d symbols, %s)",
		sess.TradingDate, sess.Ref, sess.Source, sess.SymbolCount, sess.IngestMode)

	open, err = startTick(ctx, cfg, *compID, sess.Ref)
	if err != nil {
		log.Fatalf("open tick: %v", err)
	}
	log.Printf("tick %d opened for %s", open.TickIndex, *compID)

	// Run AI participants (humans submit via the API during the window).
	for _, pid := range comp.ParticipantIDs {
		if isHuman, _ := agentIsHuman(ctx, cfg, pid); isHuman {
			continue
		}
		if err := runAIAgent(ctx, cfg, comp.SeasonID, pid, sess.Ref); err != nil {
			log.Printf("AI agent %s failed: %v", pid, err)
		} else {
			log.Printf("AI agent %s executed", pid)
		}
	}

	// Close immediately when there is no human window to respect.
	if !hasHuman || *humanWindow <= 0 {
		if err := closeTick(ctx, cfg, *compID); err != nil {
			log.Fatalf("close tick: %v", err)
		}
		log.Printf("tick %d closed for %s (no human window)", open.TickIndex, *compID)
		return
	}

	log.Printf("tick %d left open for human submissions (window %s)", open.TickIndex, humanWindow.String())
}

func getCompetition(ctx context.Context, cfg config, id string) (*competition, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+id)
	if err != nil {
		return nil, err
	}
	var comp competition
	if err := json.Unmarshal(body, &comp); err != nil {
		return nil, fmt.Errorf("decode competition: %w", err)
	}
	return &comp, nil
}

// fetchDailySession asks market-data for the most recent completed session.
// Returns the HTTP status alongside, because 204 (market closed) is a normal
// outcome and must not be confused with a fault.
func fetchDailySession(ctx context.Context, cfg config) (*sessionResult, int, error) {
	status, body, err := httpPostStatus(ctx, cfg.marketDataURL+"/internal/v1/market/sessions/daily", nil)
	if err != nil {
		return nil, status, err
	}
	if status == http.StatusNoContent {
		return nil, status, nil
	}
	if status >= 400 {
		return nil, status, fmt.Errorf("market-data returned HTTP %d: %s", status, string(body))
	}
	var out sessionResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, status, fmt.Errorf("decode session response: %w", err)
	}
	if out.Ref == "" {
		return nil, status, fmt.Errorf("market-data returned no snapshot ref")
	}
	return &out, status, nil
}

// tickExistsForRef reports whether this competition already has a tick on the
// given snapshot. This is what makes the 01:00/03:00 retries no-ops after a
// successful 23:00 run.
func tickExistsForRef(ctx context.Context, cfg config, compID, ref string) (bool, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/ticks")
	if err != nil {
		return false, err
	}
	var ticks []openTick
	if err := json.Unmarshal(body, &ticks); err != nil {
		return false, fmt.Errorf("decode ticks: %w", err)
	}
	for _, t := range ticks {
		if t.MarketSnapshotRef == ref {
			return true, nil
		}
	}
	return false, nil
}

func startTick(ctx context.Context, cfg config, compID, snapRef string) (*openTick, error) {
	payload, _ := json.Marshal(map[string]string{"marketSnapshotRef": snapRef})
	resp, err := httpPost(ctx, cfg.agentServiceURL+"/internal/v1/competitions/"+compID+"/ticks", payload)
	if err != nil {
		return nil, err
	}
	return decodeOpenTick(resp)
}

func getOpenTick(ctx context.Context, cfg config, compID string) (*openTick, error) {
	resp, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/tick/open")
	if err != nil {
		return nil, err
	}
	var out struct {
		Tick *openTick `json:"tick"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return nil, fmt.Errorf("decode open tick response: %w", err)
	}
	if out.Tick == nil {
		return &openTick{}, nil
	}
	return out.Tick, nil
}

func decodeOpenTick(resp []byte) (*openTick, error) {
	var t openTick
	if err := json.Unmarshal(resp, &t); err != nil {
		return nil, fmt.Errorf("decode tick response: %w", err)
	}
	return &t, nil
}

func closeTick(ctx context.Context, cfg config, compID string) error {
	_, err := httpPost(ctx, cfg.agentServiceURL+"/internal/v1/competitions/"+compID+"/ticks/close", nil)
	return err
}

func agentIsHuman(ctx context.Context, cfg config, agentID string) (bool, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/agents/"+agentID)
	if err != nil {
		return false, err
	}
	var agent struct {
		StrategyType string `json:"strategyType"`
	}
	if err := json.Unmarshal(body, &agent); err != nil {
		return false, fmt.Errorf("decode agent: %w", err)
	}
	return agent.StrategyType == "human", nil
}

func runAIAgent(ctx context.Context, cfg config, seasonID, agentID, snapRef string) error {
	payload, _ := json.Marshal(map[string]string{
		"agent_id":            agentID,
		"season_id":           seasonID,
		"market_snapshot_ref": snapRef,
	})
	_, err := httpPost(ctx, cfg.decisionEngineURL+"/internal/v1/decisions/execute", payload)
	return err
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}


// internalKey is the machine-tier credential every /internal/* call must carry.
//
// Read once at start. An empty value is NOT treated as "no header needed": the
// services answer 503 without it, so the scheduler would fail loudly on its
// first call rather than quietly opening an unauthenticated tick.
var internalKey = os.Getenv("INTERNAL_API_KEY")

// applyInternalKey adds the header to any request aimed at an /internal/ path.
// Public reads (a competition, an agent) are left untouched.
func applyInternalKey(req *http.Request) {
	if internalKey != "" && strings.Contains(req.URL.Path, "/internal/") {
		req.Header.Set("X-Internal-Key", internalKey)
	}
}
func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	applyInternalKey(req)
	return do(req)
}

func httpPost(ctx context.Context, url string, payload []byte) ([]byte, error) {
	status, body, err := httpPostStatus(ctx, url, payload)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, fmt.Errorf("http %d: %s", status, string(body))
	}
	return body, nil
}

func httpPostStatus(ctx context.Context, url string, payload []byte) (int, []byte, error) {
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	applyInternalKey(req)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, buf.Bytes(), nil
}

func do(req *http.Request) ([]byte, error) {
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, buf.String())
	}
	return buf.Bytes(), nil
}
