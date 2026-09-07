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
		return nil, fmt.Errorf("fetch snapshot %s: status %d: %s", ref, resp.StatusCode, string(body))
	}

	var snap Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return nil, fmt.Errorf("decode snapshot %s: %w", ref, err)
	}
	return &snap, nil
}
