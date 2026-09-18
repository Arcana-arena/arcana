package upstream

import (
	"net/http"
	"strings"
	"testing"
)

// The bug that made the code's survival a matter of luck.
//
// The workers built their errors as `truncate(string(body), 200)`, and the body
// is the whole envelope with the code near the front and the message after it.
// A short message left the code inside the first 200 characters; a long one
// pushed it out. Same defect, same service, different day — which is exactly
// the kind of thing that looks intermittent and is not.
func TestALongMessageCannotHideTheCode(t *testing.T) {
	long := strings.Repeat("the pool could not be read and here is a great deal of detail about it. ", 40)
	body := `{"error":{"code":"pool_unreadable","message":"` + long + `","trace_id":"abc"}}`
	if len(body) < 400 {
		t.Fatalf("this test needs a body longer than the old 200-char cut, got %d", len(body))
	}

	e := From(http.MethodPost, "http://market-data/internal/v1/market/ticks/pool", http.StatusBadGateway, []byte(body))
	if e.Code != "pool_unreadable" {
		t.Errorf("code = %q, want pool_unreadable — it was lost in a long message", e.Code)
	}
	if !strings.Contains(e.Error(), "pool_unreadable") {
		t.Errorf("the rendered error does not name the code: %s", e.Error())
	}
	// And the old rendering is what this replaces: proof the truncation would
	// in fact have cut the code out is that the code sits past the boundary
	// only when the message is short — so assert the code is not dependent on
	// the message at all by checking a far longer one too.
	longer := `{"error":{"message":"` + long + long + `","code":"pool_unreadable"}}`
	if got := From("", "u", 502, []byte(longer)); got.Code != "pool_unreadable" {
		t.Errorf("code = %q when the code sits AFTER a very long message", got.Code)
	}
}

func TestCodesAndClassification(t *testing.T) {
	cases := []struct {
		name          string
		status        int
		body          string
		wantCode      string
		wantNoCode    bool
		wantRetryable bool
	}{
		{
			name:     "the platform envelope",
			status:   http.StatusBadGateway,
			body:     `{"error":{"code":"vendor_unavailable","message":"polygon answered 503"}}`,
			wantCode: "vendor_unavailable", wantRetryable: true,
		},
		{
			name:     "a config fault is not an outage",
			status:   http.StatusServiceUnavailable,
			body:     `{"error":{"code":"pool_prices_unconfigured","message":"no pool configured"}}`,
			wantCode: "pool_prices_unconfigured", wantRetryable: true,
		},
		{
			name:     "a refusal about the request itself is not retryable",
			status:   http.StatusNotFound,
			body:     `{"error":{"code":"snapshot_not_found","message":"no such ref"}}`,
			wantCode: "snapshot_not_found", wantRetryable: false,
		},
		{
			name:     "the signer's slimmer envelope",
			status:   http.StatusTooManyRequests,
			body:     `{"refused":true,"code":"daily_cap_reached","message":"cap spent"}`,
			wantCode: "daily_cap_reached", wantRetryable: false,
		},
		{
			name:       "a gateway, which named nothing",
			status:     http.StatusBadGateway,
			body:       `<html>502 Bad Gateway</html>`,
			wantCode:   "no_code_from_service",
			wantNoCode: true, wantRetryable: true,
		},
		{
			name:       "an empty body",
			status:     http.StatusInternalServerError,
			body:       ``,
			wantCode:   "no_code_from_service",
			wantNoCode: true, wantRetryable: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := From(http.MethodGet, "http://svc/x", c.status, []byte(c.body))
			if e.Code != c.wantCode {
				t.Errorf("code = %q, want %q", e.Code, c.wantCode)
			}
			if e.NoCode() != c.wantNoCode {
				t.Errorf("NoCode() = %v, want %v", e.NoCode(), c.wantNoCode)
			}
			if e.Retryable() != c.wantRetryable {
				t.Errorf("Retryable() = %v, want %v", e.Retryable(), c.wantRetryable)
			}
			if e.Status != c.status {
				t.Errorf("status = %d, want %d", e.Status, c.status)
			}
		})
	}
}
