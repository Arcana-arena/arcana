// Command backfill loads historical trading sessions into market_snapshots.
//
// Snapshots ONLY — it never creates a decision, a tick or a portfolio. What it
// buys is depth: /previous has something to compare against from the first live
// tick, and Agent DNA has months of price history instead of waiting months to
// accumulate it.
//
// Everything it writes is marked ingest_mode='backfill', and agent-service
// refuses to open a competition tick on such a snapshot. That refusal is the
// point. Backfilled prices are real, but their outcome was already knowable
// when they were fetched, so a season run over them is a backtest — and §5's
// "decisions are recorded before the outcome is known" would quietly stop being
// true in the one place the platform's whole claim rests on. Backfill for
// depth; run scored seasons forward.
//
// Usage:
//
//	backfill -sessions 60 [-market-data http://localhost:8083] [-rate 12s]
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

func main() {
	sessions := flag.Int("sessions", 60, "how many weekday sessions to walk back over")
	marketDataURL := flag.String("market-data", envOr("MARKET_DATA_URL", "http://localhost:8083"), "market-data base URL")
	// The free Basic tier allows 5 requests/minute. 12s between calls keeps us
	// at exactly that ceiling without bursting into a 429 that would abort a
	// long run part-way.
	rate := flag.Duration("rate", 12*time.Second, "delay between vendor requests (free tier is 5/min)")
	flag.Parse()

	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		log.Fatalf("load US Eastern timezone: %v", err)
	}

	// Start from yesterday's session and walk back: today's may not have closed.
	start := time.Now().In(et).AddDate(0, 0, -1)
	ctx := context.Background()

	var created, existed, closed, failed int
	d := start
	for i := 0; i < *sessions; i++ {
		for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			d = d.AddDate(0, 0, -1)
		}
		day := d.Format("2006-01-02")

		status, body, err := post(ctx, *marketDataURL+"/internal/v1/market/sessions/backfill",
			map[string]string{"date": day})
		switch {
		case err != nil:
			failed++
			log.Printf("%s FAILED: %v", day, err)
		case status == http.StatusNoContent:
			closed++
			log.Printf("%s market closed (holiday or non-session) — skipped", day)
		case status == http.StatusCreated:
			created++
			log.Printf("%s stored: %s", day, refOf(body))
		case status == http.StatusOK:
			existed++
			log.Printf("%s already stored: %s", day, refOf(body))
		default:
			failed++
			log.Printf("%s FAILED: HTTP %d: %s", day, status, string(body))
		}

		d = d.AddDate(0, 0, -1)
		if i < *sessions-1 {
			time.Sleep(*rate)
		}
	}

	log.Printf("backfill done: %d created, %d already present, %d closed, %d failed",
		created, existed, closed, failed)
	if failed > 0 {
		// A partial backfill is not a disaster — it is idempotent, so re-running
		// fills the gaps — but it must not exit 0 and look complete.
		os.Exit(1)
	}
}

func refOf(body []byte) string {
	var out struct {
		Ref string `json:"market_snapshot_ref"`
	}
	_ = json.Unmarshal(body, &out)
	return out.Ref
}

func post(ctx context.Context, url string, payload any) (int, []byte, error) {
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read response: %w", err)
	}
	return resp.StatusCode, buf.Bytes(), nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
