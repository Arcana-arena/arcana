// Command scheduler advances one competition by one tick.
//
// It is designed to be invoked once per tick (externally by cron/Argo). For a
// human_vs_ai competition it:
//  1. simulates the next market snapshot (calls market-data simulate endpoint)
//  2. opens the tick on the agent-service (records phase=open + snapshot ref)
//  3. executes every AI participant (auto-decision) against that snapshot
//  4. closes the tick — the human window is [open..close]; in production the
//     close happens after the configured human window elapses
//
// Usage: scheduler -competition <id> [-interval-mins 5]
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
	agentServiceURL  string
	decisionEngineURL string
	marketDataURL    string
	scoringURL       string
}

type competition struct {
	ID             string   `json:"id"`
	SeasonID       string   `json:"seasonId"`
	Type           string   `json:"type"`
	ParticipantIDs []string `json:"participantIds"`
	Status         string   `json:"status"`
}

type snapshot struct {
	Symbols []struct {
		Symbol string  `json:"symbol"`
		Price  float64 `json:"price"`
	} `json:"symbols"`
}

func main() {
	compID := flag.String("competition", "", "competition id to advance")
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

	// Load competition participants.
	comp, err := getCompetition(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("load competition: %v", err)
	}
	if comp.Status == "completed" {
		log.Printf("competition %s already completed; nothing to do", *compID)
		return
	}

	// 1. Simulate next market snapshot.
	tickTime := time.Now().UTC().Truncate(time.Second)
	snapRef, err := simulateMarket(ctx, cfg, tickTime)
	if err != nil {
		log.Fatalf("simulate market: %v", err)
	}
	log.Printf("tick snapshot: %s", snapRef)

	// 2. Open tick.
	if err := openTick(ctx, cfg, *compID, snapRef); err != nil {
		log.Fatalf("open tick: %v", err)
	}
	log.Printf("tick opened for %s", *compID)

	// 3. Run AI participants (skip humans - they submit via API).
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

	// 4. Close the tick (human window elapses in real deployments via a later
	//    scheduler invocation; single-shot mode closes immediately after AI run).
	if err := closeTick(ctx, cfg, *compID); err != nil {
		log.Fatalf("close tick: %v", err)
	}
	log.Printf("tick closed for %s", *compID)
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

func openTick(ctx context.Context, cfg config, compID, snapRef string) error {
	payload, _ := json.Marshal(map[string]string{"marketSnapshotRef": snapRef})
	_, err := httpPost(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/ticks", payload)
	return err
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
