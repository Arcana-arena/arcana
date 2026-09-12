// Package vendor reads real market prices from Polygon/Massive.
//
// One endpoint does the whole job:
//
//	GET /v2/aggs/grouped/locale/us/market/stocks/{date}
//
// It returns the daily OHLCV for EVERY US ticker in a single request, which is
// why the universe can be 50 symbols or 500 at the same cost, and why the free
// Basic tier (5 requests/minute, end-of-day) is enough to run a daily
// competition. See docs/market-data.md.
//
// The rule this package exists to keep: it NEVER invents a price. There is no
// fallback generator, no last-known-good substitution, no partial fill. If the
// vendor cannot be read, the caller gets an error and the tick does not open —
// a paused competition is recoverable, an agent scored against a made-up price
// is not. This is the same principle the $ARCA entitlement client follows when
// its authority is unreachable: report what happened, decide nothing.
package vendor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ErrMarketClosed means the vendor answered successfully and the session did
// not exist: a weekend, a holiday, or an unscheduled closure.
//
// It is deliberately a DISTINCT error from a vendor failure. "There was no
// trading day" is a normal outcome that ends in no tick and exit 0; "we could
// not find out" is a fault that has to be loud. Collapsing the two would make
// an outage look like a public holiday, and a competition would sit silently
// idle looking healthy.
var ErrMarketClosed = errors.New("market closed: the vendor reports no session on this date")

// ErrNotConfigured means no API key was supplied.
var ErrNotConfigured = errors.New("market data vendor is not configured (MARKET_VENDOR_API_KEY unset)")

// Bar is one symbol's daily aggregate.
type Bar struct {
	Symbol string
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume float64
	VWAP   float64
	// Trades is the number of transactions in the session. Carried because a
	// suspiciously low count is one of the few cheap signals that a quote is
	// stale or thin rather than simply unchanged.
	Trades int64
}

// Client reads grouped daily bars.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
	name    string
}

// Config for the vendor client.
type Config struct {
	// BaseURL defaults to the Polygon host. api.polygon.io still serves after
	// the Massive rebrand (Oct 2025) and existing keys work on both.
	BaseURL string
	APIKey  string
	// Name is recorded on every snapshot as its `source`.
	Name    string
	Timeout time.Duration
}

func New(cfg Config) *Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.polygon.io"
	}
	if cfg.Name == "" {
		cfg.Name = "polygon"
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &Client{
		baseURL: cfg.BaseURL,
		apiKey:  cfg.APIKey,
		name:    cfg.Name,
		http:    &http.Client{Timeout: cfg.Timeout},
	}
}

// Name is the vendor identifier recorded on snapshots.
func (c *Client) Name() string { return c.name }

// Configured reports whether an API key is present.
//
// Deliberately separate from the fetch: the service checks this at boot so it
// can WARN once, loudly, rather than failing anonymously at 23:00 every night.
func (c *Client) Configured() bool { return c.apiKey != "" }

type groupedResponse struct {
	Status       string `json:"status"`
	QueryCount   int    `json:"queryCount"`
	ResultsCount int    `json:"resultsCount"`
	Adjusted     bool   `json:"adjusted"`
	RequestID    string `json:"request_id"`
	Message      string `json:"message"`
	Error        string `json:"error"`
	Results      []struct {
		Ticker string  `json:"T"`
		Open   float64 `json:"o"`
		High   float64 `json:"h"`
		Low    float64 `json:"l"`
		Close  float64 `json:"c"`
		Volume float64 `json:"v"`
		VWAP   float64 `json:"vw"`
		Trades int64   `json:"n"`
		// Declared purely to keep `t` away from `T`.
		//
		// encoding/json matches field names CASE-INSENSITIVELY when no exact
		// match exists, and the grouped response carries both "T" (ticker,
		// string) and "t" (timestamp, number). Without this field, "t" fell
		// through to Ticker and every response failed to decode with
		// `cannot unmarshal number into ... .T of type string` — the whole
		// session, not one symbol. An exact tag wins over a case-insensitive
		// one, so declaring it binds each key where it belongs.
		TimestampMs int64 `json:"t"`
	} `json:"results"`
}

// GroupedDaily fetches every US ticker's daily bar for one session.
//
// Returns ErrMarketClosed when the vendor answers OK with no results, which is
// how a non-trading day presents. Using the vendor's own data as the trading
// calendar is deliberate: a hardcoded holiday table drifts, and it cannot know
// about unscheduled closures (a national day of mourning shuts the NYSE with
// days of notice). The vendor already knows which sessions exist, so asking it
// is both cheaper and more correct than maintaining a second answer.
func (c *Client) GroupedDaily(ctx context.Context, date time.Time) ([]Bar, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}

	day := date.Format("2006-01-02")
	endpoint := fmt.Sprintf("%s/v2/aggs/grouped/locale/us/market/stocks/%s", c.baseURL, day)
	q := url.Values{}
	q.Set("adjusted", "true")
	q.Set("apiKey", c.apiKey)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("vendor request for %s failed: %w", day, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("read vendor response for %s: %w", day, err)
	}

	// Named explicitly rather than lumped into "not OK": these three have
	// different remedies, and an operator reading the journal at 23:05 should
	// not have to guess which one they are looking at.
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("vendor rate limit hit for %s (HTTP 429): the free tier allows 5 requests/minute", day)
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, fmt.Errorf("vendor rejected the API key for %s (HTTP %d): check MARKET_VENDOR_API_KEY and the plan's entitlements", day, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vendor returned HTTP %d for %s: %s", resp.StatusCode, day, truncate(string(body), 300))
	}

	var out groupedResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode vendor response for %s: %w", day, err)
	}
	if out.Status != "OK" && out.Status != "DELAYED" {
		msg := out.Message
		if msg == "" {
			msg = out.Error
		}
		return nil, fmt.Errorf("vendor status %q for %s: %s", out.Status, day, msg)
	}
	if len(out.Results) == 0 {
		return nil, ErrMarketClosed
	}

	bars := make([]Bar, 0, len(out.Results))
	for _, r := range out.Results {
		bars = append(bars, Bar{
			Symbol: r.Ticker,
			Open:   r.Open,
			High:   r.High,
			Low:    r.Low,
			Close:  r.Close,
			Volume: r.Volume,
			VWAP:   r.VWAP,
			Trades: r.Trades,
		})
	}
	return bars, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
