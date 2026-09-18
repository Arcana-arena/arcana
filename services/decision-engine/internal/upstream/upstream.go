// Package upstream reads the error envelope every ARCANA service emits, so a
// caller ends up with the code the callee chose rather than a sentence.
//
// WHY THIS IS SHARED AND NOT COPIED INTO EACH WORKER. The cadence loop and the
// scheduler each had four or five call sites building errors with fmt.Errorf,
// and every one of them threw the code away the same way. Written out per
// worker, the next one to be fixed would be whichever one somebody happened to
// be reading — the same reason lib/chain.mjs was pulled out of two verifier
// suites that had drifted apart.
//
// THE TRUNCATION BUG THIS ALSO CLOSES. Those call sites read
// `truncate(string(body), 200)`, and the body is the whole envelope:
//
//	{"error":{"code":"pool_prices_unconfigured","message":"...","trace_id":"..."}}
//
// so whether the code survived depended on how long the message happened to be.
// A short message left it readable in the string; a long one cut it off. That
// is not a policy about log length, it is luck. Here the code is parsed out
// FIRST and kept whole; only the leftover raw body is bounded.
package upstream

import (
	"encoding/json"
	"fmt"
)

// Error is a non-2xx answer from another ARCANA service, with its own code.
type Error struct {
	Method  string
	URL     string
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	where := e.Method + " " + e.URL
	if e.Method == "" {
		where = e.URL
	}
	return fmt.Sprintf("%s answered %d %s: %s", where, e.Status, e.Code, e.Message)
}

// Retryable separates an outage, which the next run may survive, from a
// refusal about the request itself, which it will not.
func (e *Error) Retryable() bool { return e.Status >= 500 }

// NoCode reports whether the answer carried no code of its own — a proxy, a
// gateway, or a crash before the body was written. The distinction matters:
// "market-data refused this" and "something in front of market-data answered"
// send a reader to two different machines.
func (e *Error) NoCode() bool { return e.Code == noCode }

const noCode = "no_code_from_service"

// From builds an Error from a non-2xx response body.
func From(method, url string, status int, body []byte) *Error {
	e := &Error{Method: method, URL: url, Status: status}

	// The platform envelope: {"error":{"code","message"}}.
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err == nil && env.Error.Code != "" {
		e.Code, e.Message = env.Error.Code, env.Error.Message
		return e
	}

	// The signer's slimmer variant: {"refused":true,"code","message"}.
	var refused struct {
		Refused bool   `json:"refused"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &refused); err == nil && refused.Refused && refused.Code != "" {
		e.Code, e.Message = refused.Code, refused.Message
		return e
	}

	e.Code = noCode
	e.Message = "the answer carried no code, so it did not come from the service itself: " +
		truncate(string(body), 200)
	return e
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
