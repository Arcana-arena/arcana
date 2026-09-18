package marketdata

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A gap in the data and an outage are different things, and this client used to
// hand both to the engine as the same sentence.
//
// `snapshot_not_found` means the tick a decision needs was never stored — no
// amount of retrying produces it, and somebody has to look at why it is
// missing. `vendor_unavailable` means the price feed is down and the next run
// will probably work. Stringified into `fmt.Errorf("...status %d: %s")` they
// were indistinguishable, and the engine's handler then re-emitted every one of
// them as `execute_failed`.

func mdReturning(t *testing.T, status int, body string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL)
}

func TestMarketDataFaultsKeepTheirCode(t *testing.T) {
	cases := []struct {
		name          string
		status        int
		body          string
		wantCode      string
		wantRetryable bool
	}{
		{
			name:          "a snapshot that was never stored",
			status:        http.StatusNotFound,
			body:          `{"error":{"code":"snapshot_not_found","message":"snapshot t-42 not found"}}`,
			wantCode:      "snapshot_not_found",
			wantRetryable: false,
		},
		{
			name:          "the price vendor is down",
			status:        http.StatusBadGateway,
			body:          `{"error":{"code":"vendor_unavailable","message":"polygon answered 503"}}`,
			wantCode:      "vendor_unavailable",
			wantRetryable: true,
		},
		{
			name:          "the vendor was never configured",
			status:        http.StatusServiceUnavailable,
			body:          `{"error":{"code":"vendor_not_configured","message":"POLYGON_API_KEY is unset"}}`,
			wantCode:      "vendor_not_configured",
			wantRetryable: true,
		},
		{
			name:          "something that is not market-data answered",
			status:        http.StatusBadGateway,
			body:          `<html>502 Bad Gateway</html>`,
			wantCode:      "market_data_unreadable",
			wantRetryable: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for _, call := range []struct {
				what string
				fn   func(*Client) error
			}{
				{"GetSnapshot", func(cl *Client) error { _, err := cl.GetSnapshot(context.Background(), "t-42"); return err }},
				{"GetPreviousSnapshot", func(cl *Client) error {
					_, err := cl.GetPreviousSnapshot(context.Background(), "t-42")
					return err
				}},
			} {
				err := call.fn(mdReturning(t, c.status, c.body))
				var f *Fault
				if !errors.As(err, &f) {
					t.Fatalf("%s: no Fault in the chain: %v", call.what, err)
				}
				if f.Code != c.wantCode {
					t.Errorf("%s: code = %q, want %q", call.what, f.Code, c.wantCode)
				}
				if f.Retryable() != c.wantRetryable {
					t.Errorf("%s: retryable = %v, want %v", call.what, f.Retryable(), c.wantRetryable)
				}

				// THE PART THAT ACTUALLY BROKE. The engine wraps this error twice
				// on its way to the HTTP handler; if any hop used %v instead of
				// %w the code would be gone by the time anybody looked for it.
				wrapped := fmt.Errorf("market snapshot: %w", fmt.Errorf("previous snapshot: %w", err))
				var throughWrapping *Fault
				if !errors.As(wrapped, &throughWrapping) {
					t.Errorf("%s: the code does not survive two layers of wrapping: %v", call.what, wrapped)
				} else if throughWrapping.Code != c.wantCode {
					t.Errorf("%s: after wrapping code = %q, want %q", call.what, throughWrapping.Code, c.wantCode)
				}
			}
		})
	}
}

// The first tick of a season has no previous snapshot, and that is not a fault.
// Turning 204 into a coded error would make every season start look broken.
func TestNoPreviousSnapshotIsStillNotAnError(t *testing.T) {
	snap, err := mdReturning(t, http.StatusNoContent, "").GetPreviousSnapshot(context.Background(), "t-1")
	if err != nil || snap != nil {
		t.Fatalf("204 should be (nil, nil), got (%v, %v)", snap, err)
	}
}
