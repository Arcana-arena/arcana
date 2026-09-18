package marketdata

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Quote mirrors the market-data service payload.
type Quote struct {
	Symbol string  `json:"symbol"`
	Price  float64 `json:"price"`
	Volume float64 `json:"volume"`
}

// Snapshot is the immutable market state for one tick window.
type Snapshot struct {
	Ref      string    `json:"ref"`
	TickTime time.Time `json:"tick_time"`
	Symbols  []Quote   `json:"symbols"`
	Source   string    `json:"source"`
}

// Fault is market-data answering with a code of its own.
//
// WHAT IT REPLACES, AND WHY IT MATTERS THREE HOPS LATER. This client used to
// return `fmt.Errorf("...status %d: %s", status, body)` — the whole JSON
// envelope stringified into a sentence. The engine then wrapped that twice and
// its HTTP handler re-emitted every failure as one code, `execute_failed`. So
// `snapshot_not_found`, which means the tick this decision needs was never
// stored, and `vendor_unavailable`, which means the price feed is down, arrived
// at agent-service as the same 422 with a prose blob. One is a gap in the data
// that will not fix itself by retrying; the other is an outage that will.
//
// Carrying the code as a field means the wrapping above can stay exactly as it
// is: `%w` keeps the chain intact, and errors.As finds this at the far end.
type Fault struct {
	Ref     string
	Code    string
	Status  int
	Message string
}

func (e *Fault) Error() string {
	return fmt.Sprintf("market-data refused %s for %s (HTTP %d): %s", e.Code, e.Ref, e.Status, e.Message)
}

// Retryable separates "come back later" from "this will never work".
//
// A 5xx is the service failing and a retry is reasonable. A 404 for a snapshot
// that was never stored is a fact about the data, and retrying it forever is
// how a scheduler spins.
func (e *Fault) Retryable() bool { return e.Status >= 500 }

// fault reads market-data's error envelope, falling back to a named code when
// the answer did not come from market-data at all.
func fault(ref string, status int, body []byte) *Fault {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err == nil && env.Error.Code != "" {
		return &Fault{Ref: ref, Code: env.Error.Code, Status: status, Message: env.Error.Message}
	}
	// No envelope: a proxy, a gateway, or a crash before the body was written.
	// Named rather than left blank, so the far end still has something to
	// branch on and can tell it apart from a refusal market-data actually made.
	return &Fault{
		Ref: ref, Code: "market_data_unreadable", Status: status,
		Message: fmt.Sprintf("the answer carried no error code, so it did not come from market-data: %s",
			truncate(string(body), 200)),
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Client fetches market snapshots from the Market Data Service.
type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// GetSnapshot fetches the immutable snapshot payload for a ref.
func (c *Client) GetSnapshot(ctx context.Context, ref string) (*Snapshot, error) {
	url := fmt.Sprintf("%s/v1/market/snapshots/%s", c.baseURL, ref)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch snapshot %s: %w", ref, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fault(ref, resp.StatusCode, body)
	}

	var snap Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return nil, fmt.Errorf("decode snapshot %s: %w", ref, err)
	}
	return &snap, nil
}

// GetPreviousSnapshot fetches the snapshot immediately preceding ref.
// Returns (nil, nil) on the first tick of a season: having no prior prices is
// a normal state that strategies handle by standing still, not an error.
func (c *Client) GetPreviousSnapshot(ctx context.Context, ref string) (*Snapshot, error) {
	url := fmt.Sprintf("%s/v1/market/snapshots/%s/previous", c.baseURL, ref)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch previous snapshot for %s: %w", ref, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fault(ref, resp.StatusCode, body)
	}

	var snap Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return nil, fmt.Errorf("decode previous snapshot for %s: %w", ref, err)
	}
	return &snap, nil
}
