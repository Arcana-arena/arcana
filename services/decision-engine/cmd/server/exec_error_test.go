package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/arcana/decision-engine/internal/marketdata"
)

// The boundary where every cause used to become one word.
//
// `writeError(w, 422, "execute_failed", err.Error())` was the whole of it, so
// agent-service could not tell a missing tick from a dead price feed from a
// database that would not answer. This checks the handler now answers with the
// code of whatever actually refused — through the two layers of %w wrapping the
// engine puts in between, which is the part that would break silently if
// anybody changed a %w to a %v.
func TestWriteExecErrorKeepsTheCause(t *testing.T) {
	// As the engine wraps it: engine.Execute -> "market snapshot: %w".
	wrap := func(e error) error {
		return fmt.Errorf("market snapshot: %w", fmt.Errorf("previous snapshot: %w", e))
	}

	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "a tick that was never stored is not retryable",
			err:        wrap(&marketdata.Fault{Ref: "t-42", Code: "snapshot_not_found", Status: http.StatusNotFound}),
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "snapshot_not_found",
		},
		{
			name:       "a dead price feed is",
			err:        wrap(&marketdata.Fault{Ref: "t-42", Code: "vendor_unavailable", Status: http.StatusBadGateway}),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "vendor_unavailable",
		},
		{
			name:       "anything else still answers execute_failed",
			err:        wrap(errors.New("append decision: context deadline exceeded")),
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "execute_failed",
		},
	}

	seen := map[string]bool{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeExecError(rec, c.err)

			if rec.Code != c.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, c.wantStatus)
			}
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("the answer is not the platform envelope: %s", rec.Body.String())
			}
			if body.Error.Code != c.wantCode {
				t.Errorf("code = %q, want %q", body.Error.Code, c.wantCode)
			}
			// The message still describes it; naming the failure does not
			// replace saying what happened.
			if body.Error.Message == "" {
				t.Error("the answer carries a code and no message")
			}
			seen[body.Error.Code] = true
		})
	}

	if len(seen) != 3 {
		t.Errorf("three causes produced %d distinct codes: %v", len(seen), seen)
	}
}
