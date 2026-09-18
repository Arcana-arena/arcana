package main

import (
	"context"
	"errors"
	"net/http"
	"math/big"
	"net/http/httptest"
	"strings"
	"testing"
)

// Can the person on call tell "wait" from "act"?
//
// That is the whole question this file exists to answer, and until now the
// answer was no. Twelve refusal codes reached the alert as one sentence built
// by fmt.Errorf, so `daily_cap_reached` — where the only correct response is to
// do nothing until midnight — was indistinguishable from `fee_above_cap`, which
// can be retried within the minute, and from `anchor_signer_not_configured`,
// which never clears until somebody installs a key.

func signerSaying(t *testing.T, status int, body string) *signer {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &signer{url: srv.URL, key: "test-key"}
}

func TestAnchorRefusalsAreToldApart(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{
			name:     "the daily cap",
			status:   http.StatusTooManyRequests,
			body:     `{"refused":true,"code":"daily_cap_reached","message":"12 of 12 signatures used today"}`,
			wantCode: "daily_cap_reached",
		},
		{
			name:     "a fee above the ceiling",
			status:   http.StatusUnprocessableEntity,
			body:     `{"refused":true,"code":"fee_above_cap","message":"max_fee_wei 90000000000 exceeds the cap"}`,
			wantCode: "fee_above_cap",
		},
		{
			name:     "no key installed",
			status:   http.StatusServiceUnavailable,
			body:     `{"refused":true,"code":"anchor_signer_not_configured","message":"no anchoring key"}`,
			wantCode: "anchor_signer_not_configured",
		},
	}

	steps := map[string]string{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := signerSaying(t, c.status, c.body).sign(
				context.Background(), "0xroot", 1, bigOne(), bigOne(), 21000)
			var ref *signerRefusal
			if !errors.As(err, &ref) {
				t.Fatalf("a refusal did not survive as one: %v", err)
			}
			if ref.Code != c.wantCode {
				t.Errorf("code = %q, want %q", ref.Code, c.wantCode)
			}
			if ref.Status != c.status {
				t.Errorf("status = %d, want %d", ref.Status, c.status)
			}
			step := nextStep(ref.Code)
			if step == "" || strings.HasPrefix(step, "no next step is recorded") {
				t.Errorf("%s has no recorded next step, so the alert names a code and nothing to do", ref.Code)
			}
			steps[ref.Code] = step
		})
	}

	// THE POINT, ASSERTED DIRECTLY. Three codes that each produced the same
	// prose before must now produce three different instructions.
	if len(steps) != 3 {
		t.Fatalf("expected three distinct codes, got %d", len(steps))
	}
	if steps["daily_cap_reached"] == steps["fee_above_cap"] {
		t.Error("waiting until midnight and lowering a fee read identically to an operator")
	}
	if !strings.Contains(steps["daily_cap_reached"], "resets") {
		t.Errorf("the cap's next step does not say it clears by itself: %q", steps["daily_cap_reached"])
	}
	if !strings.Contains(steps["fee_above_cap"], "NOW") {
		t.Errorf("the fee's next step does not say it is retryable now: %q", steps["fee_above_cap"])
	}
	if !strings.Contains(steps["anchor_signer_not_configured"], "does not clear on its own") {
		t.Errorf("the unconfigured signer's next step does not say it needs a person: %q",
			steps["anchor_signer_not_configured"])
	}
}

// `refused: true` is the discriminator, not merely the presence of a code.
//
// A gateway in front of the signer can answer 503 with any JSON it likes. Read
// as a refusal, that would tell an operator the signer declined — a decision it
// never made, and quite possibly never saw the request to make.
func TestOnlyTheSignerItselfCanRefuse(t *testing.T) {
	for _, body := range []string{
		`{"upstream":"no healthy backends"}`,
		`{"code":"daily_cap_reached"}`,          // a code, but nothing claiming to be the signer
		`{"refused":false,"code":"bad_reques"}`, // explicitly not a refusal
		`not json at all`,
	} {
		_, err := signerSaying(t, http.StatusServiceUnavailable, body).sign(
			context.Background(), "0xroot", 1, bigOne(), bigOne(), 21000)
		if err == nil {
			t.Fatalf("a 503 was accepted as success: %s", body)
		}
		var ref *signerRefusal
		if errors.As(err, &ref) {
			t.Errorf("a non-signer answer was read as a signer refusal (%s): %s", ref.Code, body)
		}
		if !strings.Contains(err.Error(), "did not come from the anchoring signer") {
			t.Errorf("the error does not say the answer was not the signer's: %v", err)
		}
	}
}

func bigOne() *big.Int { return big.NewInt(1) }
