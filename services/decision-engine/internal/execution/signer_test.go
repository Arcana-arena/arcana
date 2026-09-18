package execution

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// What the signer client does with each shape of answer, and — the part that
// matters — whether the three outcomes stay TOLD APART all the way to the row
// an operator reads.
//
// Two of these branches used to return a bare sentence. The code the signer had
// gone to the trouble of naming was already gone by the time the error left
// this file, so `wallet_blocked` (a policy saying no), an unparseable body (a
// version mismatch) and a 503 from something in front of the signer (a
// transport fault) all reached the decision record as prose. Three different
// next steps for an operator, one indistinguishable string.
//
// The signer is a scripted HTTP server here. A real one cannot be made to
// return a truncated body on demand, and a check that cannot be triggered is a
// check that exists only in principle.

func signerReturning(t *testing.T, status int, body string) *SignerClient {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewSignerClient(srv.URL, "test-key", &http.Client{Timeout: 5 * time.Second})
}

func TestSignerAnswersStayToldApart(t *testing.T) {
	cases := []struct {
		name string
		// what the signer (or whatever answered instead of it) sends back
		status int
		body   string
		// what this client must produce
		wantRefusal bool
		wantFault   bool
		wantCode    string
	}{
		{
			name:        "a policy refusal keeps the signer's own code",
			status:      http.StatusOK,
			body:        `{"error":{"code":"wallet_blocked","message":"this wallet is blocked"}}`,
			wantRefusal: true,
			wantCode:    "wallet_blocked",
		},
		{
			name:        "a different policy refusal is a DIFFERENT code, not a shared one",
			status:      http.StatusOK,
			body:        `{"error":{"code":"daily_signature_cap","message":"cap reached"}}`,
			wantRefusal: true,
			wantCode:    "daily_signature_cap",
		},
		{
			name:      "a body this client cannot parse is named, not narrated",
			status:    http.StatusOK,
			body:      `{"error": {"code": "wallet_bl`, // truncated mid-write
			wantFault: true,
			wantCode:  "signer_unreadable_response",
		},
		{
			name:      "a non-200 that names nothing is a transport fault, not a refusal",
			status:    http.StatusServiceUnavailable,
			body:      `{"upstream":"no healthy backends"}`,
			wantFault: true,
			wantCode:  "signer_unexpected_status",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := signerReturning(t, c.status, c.body).Sign(context.Background(), SignRequest{
				Intent: "swap_exact_in", AgentID: "a", TokenIn: "0x1", Router: "0x2", Amount: "1",
			})
			if err == nil {
				t.Fatal("the client accepted an answer that carried no signed transaction")
			}

			var ref *Refusal
			var flt *Fault
			isRefusal := errors.As(err, &ref)
			isFault := errors.As(err, &flt)

			// THE DISCRIMINATION ITSELF. A fault must not read as a refusal:
			// that would claim the signer declined when it never decided.
			if isRefusal != c.wantRefusal {
				t.Errorf("refusal=%v, want %v (err: %v)", isRefusal, c.wantRefusal, err)
			}
			if isFault != c.wantFault {
				t.Errorf("fault=%v, want %v (err: %v)", isFault, c.wantFault, err)
			}

			var got string
			switch {
			case isRefusal:
				got = ref.Code
			case isFault:
				got = flt.Code
			}
			if got != c.wantCode {
				t.Errorf("code = %q, want %q (err: %v)", got, c.wantCode, err)
			}
			// The message still has to be readable by a person; naming the
			// failure is not a licence to stop describing it.
			if !strings.Contains(err.Error(), c.wantCode) {
				t.Errorf("the error text does not carry its own code: %v", err)
			}
		})
	}
}

// And the codes must actually be DIFFERENT from each other — a set of constants
// that all collapsed to one value would pass every check above individually.
func TestSignerFaultCodesAreDistinct(t *testing.T) {
	seen := map[string]string{}
	for _, c := range []struct{ name, status, body string }{
		{"unreadable", "200", `{"error": {"code": "x`},
		{"unexpected", "503", `{"upstream":"no healthy backends"}`},
	} {
		code := http.StatusOK
		if c.status == "503" {
			code = http.StatusServiceUnavailable
		}
		_, err := signerReturning(t, code, c.body).Sign(context.Background(), SignRequest{
			Intent: "swap_exact_in", AgentID: "a", TokenIn: "0x1", Router: "0x2", Amount: "1",
		})
		var flt *Fault
		if !errors.As(err, &flt) {
			t.Fatalf("%s did not produce a Fault: %v", c.name, err)
		}
		if prev, dup := seen[flt.Code]; dup {
			t.Errorf("%s and %s share the code %q, so they cannot be told apart", c.name, prev, flt.Code)
		}
		seen[flt.Code] = c.name
	}
}
