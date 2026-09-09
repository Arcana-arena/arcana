// Package internalauth guards the ⚙️ machine tier on the Go services.
//
// It is the Go counterpart of @arcana/auth's InternalKeyGuard, and it is a
// shared module rather than three copies for the same reason the TypeScript
// side is shared: an access rule that exists in several places drifts, and this
// codebase has already been bitten by exactly that.
//
// Two layers protect these endpoints, and neither is sufficient alone:
//
//  1. every service binds to 127.0.0.1, so a leaked key is useless off-box and
//     a firewall mistake cannot expose them;
//  2. this header check, so any process on the box still has to hold the key.
//
// A missing key is NEVER a pass. It yields 503 with a message saying the check
// could not be performed — the same rule the rest of ARCANA follows: do not
// fail open, and do not fail closed in language that reads like "you are not
// allowed".
package internalauth

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const headerName = "X-Internal-Key"

// Guard wraps a handler so it is reachable only with the correct internal key.
type Guard struct {
	key string
}

// New reads INTERNAL_API_KEY once at startup and reports its state, so the
// posture is visible in the boot log next to the other ACTIVE/INACTIVE lines
// rather than discovered on the first refused request.
func New(serviceName string) *Guard {
	key := os.Getenv("INTERNAL_API_KEY")
	if key == "" {
		log.Printf(
			"WARN: %s internal tier INACTIVE: INTERNAL_API_KEY is not set — "+
				"/internal/* will reject with 503. INACTIVE does not mean open; "+
				"scheduled jobs calling this service will NOT run.",
			serviceName,
		)
	} else {
		log.Printf("%s internal tier ACTIVE: %s required on /internal/*", serviceName, headerName)
	}
	return &Guard{key: key}
}

// Wrap returns h protected by the key check.
func (g *Guard) Wrap(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.key == "" {
			writeError(w, http.StatusServiceUnavailable, "auth_unavailable",
				"INTERNAL_API_KEY is not set, so machine-tier calls cannot be verified. "+
					"The request was neither allowed nor denied.")
			return
		}

		provided := r.Header.Get(headerName)
		if provided == "" {
			writeError(w, http.StatusForbidden, "forbidden_internal",
				"This endpoint is machine-only and requires the "+headerName+" header.")
			return
		}
		// ConstantTimeCompare returns 0 on unequal length as well, so this one
		// call covers both cases without leaking length through timing.
		if subtle.ConstantTimeCompare([]byte(provided), []byte(g.key)) != 1 {
			writeError(w, http.StatusForbidden, "forbidden_internal",
				headerName+" does not match.")
			return
		}

		h(w, r)
	}
}

// writeError emits the §8 envelope: {error:{code,message,trace_id}}.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":     code,
			"message":  message,
			"trace_id": "",
		},
	})
}
