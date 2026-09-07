// Command scheduler advances one competition by one tick.
//
// It is designed to be invoked periodically (cron/Argo). Two modes:
//
//	Phase 1 (no open tick): simulate next market snapshot -> open tick ->
//	  run every AI participant. If the competition has human participants and
//	  -human-window > 0 the tick is LEFT OPEN so humans can submit via the API;
//	  otherwise it is closed immediately.
//	Phase 2 (open tick exists): once window_start + human-window has elapsed,
//	  close the tick; if still inside the window, exit without doing anything.
//
// Usage: scheduler -competition <id> [-human-window 5m]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
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
	ID             string     `json:"id"`
	TickIndex      int        `json:"tickIndex"`
	Phase          string     `json:"phase"`
	MarketSnapshotRef string   `json:"marketSnapshotRef"`
	WindowStart    *time.Time `json:"windowStart"`
	WindowEnd      *time.Time `json:"windowEnd"`
}

func main() {
	compID := flag.String("competition", "", "competition id to advance")
	humanWindow := flag.Duration("human-window", 0, "how long an open tick waits for human submissions before closing (e.g. 5m, 1h)")
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

	// Phase 1: no open tick — start the next round.
	tickTime := now
	snapRef, err := simulateMarket(ctx, cfg, tickTime)
	if err != nil {
		log.Fatalf("simulate market: %v", err)
	}
	log.Printf("tick snapshot: %s", snapRef)

	open, err = startTick(ctx, cfg, *compID, snapRef)
	if err != nil {
		log.Fatalf("open tick: %v", err)
	}
	log.Printf("tick %d opened for %s", open.TickIndex, *compID)

	// Run AI participants (humans submit via the API during the window).
	for _, pid := range comp.ParticipantIDs {
		if isHuman, _ := agentIsHuman(ctx, cfg, pid); isHuman {
			continue
		}
		if err := runAIAgent(ctx, cfg, comp.SeasonID, pid, snapRef); err != nil {
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

func simulateMarket(ctx context.Context, cfg config, tick time.Time) (string, error) {
	// Bootstrap symbols with base prices (dev fixture; real feeds come later).
	payload := map[string]any{
		"tick_time": tick.Format(time.RFC3339),
		"symbols": []map[string]any{
			{"symbol": "AAPL", "price": 110.0},
			{"symbol": "MSFT", "price": 220.0},
		},
	}
	raw, _ := json.Marshal(payload)
	resp, err := httpPost(ctx, cfg.marketDataURL+"/internal/v1/market/simulate/tick", raw)
	if err != nil {
		return "", err
	}
	var out struct {
		MarketSnapshotRef string `json:"market_snapshot_ref"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", fmt.Errorf("decode simulate response: %w", err)
	}
	return out.MarketSnapshotRef, nil
}

func startTick(ctx context.Context, cfg config, compID, snapRef string) (*openTick, error) {
	payload, _ := json.Marshal(map[string]string{"marketSnapshotRef": snapRef})
	resp, err := httpPost(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/ticks", payload)
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
	_, err := httpPost(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/ticks/close", nil)
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

func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return do(req)
}

func httpPost(ctx context.Context, url string, payload []byte) ([]byte, error) {
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return do(req)
}

func do(req *http.Request) ([]byte, error) {
	client := &http.Client{Timeout: 30 * time.Second}
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
