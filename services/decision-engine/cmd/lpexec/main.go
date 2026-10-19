// Command lpexec turns the arbitrage loop's proposed LP actions into the exact
// signer intents they would need — and sends none of them.
//
// PHASE A OF THE MONEY PATH. The assembly is the part that is easy to get
// subtly wrong — the intent sequence, the slippage floors, the deadlines — so
// it runs first, against the real queue, printing the complete signer request
// body for every step it would take. IT DOES NOT CALL THE SIGNER, DOES NOT
// BROADCAST, AND WRITES NOTHING: there is no flag that arms it, because arming
// is a separate checkpoint (docs/lp-execution.md) and arrives with the first
// funded position. What this program buys today is that the checkpoint is a
// review of concrete bodies rather than a promise about code.
//
// IT READS THE QUEUE OVER HTTP, from the service that owns the tables, rather
// than from SQL. One writer, one reader, and the arbitrage service keeps
// ownership of its schema. The three reads it makes are all public read-only
// routes, so this binary holds no credentials at all.
//
// Usage: lpexec   (no flags; the timer decides how often this looks. A run with
// an empty queue is one HTTP read, exits 0, and says so.)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
)

// lpExecutionDeadline is how long the minted/decreased transactions may take to
// be mined before the position manager refuses them. Computed at plan time,
// because the armed executor will recompute it immediately before signing —
// this value is here so the printed bodies are complete and reviewable.
const lpExecutionDeadline = 15 * time.Minute

type venuesResponse struct {
	PositionManager string `json:"position_manager"`
}

type actionsResponse struct {
	Actions []execution.LPProposal `json:"actions"`
}

type positionsResponse struct {
	Positions []execution.LPRegistryRow `json:"positions"`
}

type positionResponse struct {
	Position execution.LPPositionRead `json:"position"`
}

type summary struct {
	Arbitrage       string                   `json:"arbitrage"`
	PositionManager string                   `json:"position_manager"`
	DeadlineUnix    int64                    `json:"deadline_unix"`
	Proposals       int                      `json:"proposals"`
	Planned         int                      `json:"planned"`
	Refused         int                      `json:"refused"`
	Plans           []execution.LPActionPlan `json:"plans"`
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	arb := envOr("ARBITRAGE_URL", "http://127.0.0.1:8084")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var venues venuesResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/venues", &venues); err != nil {
		log.Fatalf("read venues: %v", err)
	}

	out := summary{
		Arbitrage:       arb,
		PositionManager: venues.PositionManager,
		DeadlineUnix:    time.Now().Add(lpExecutionDeadline).Unix(),
		Plans:           []execution.LPActionPlan{},
	}

	var actions actionsResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/lp/actions?limit=200", &actions); err != nil {
		log.Fatalf("read the proposal queue: %v — nothing was planned", err)
	}
	out.Proposals = len(actions.Actions)
	if len(actions.Actions) == 0 {
		// The normal answer: the LP loop proposes only when a position is out
		// of range or empty, and no agent owns a position yet. Quiet, exit 0.
		log.Printf("no proposed LP actions")
		writeSummary(out)
		return
	}
	log.Printf("%d proposed LP action(s)", len(actions.Actions))

	var rows positionsResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/lp/positions?status=all&limit=500", &rows); err != nil {
		log.Fatalf("read the registry: %v — nothing was planned", err)
	}
	byToken := make(map[string]execution.LPRegistryRow, len(rows.Positions))
	for _, r := range rows.Positions {
		byToken[r.TokenID] = r
	}

	for _, p := range actions.Actions {
		pos, why := readPosition(ctx, arb, p.TokenID)
		if why != "" {
			// Not a fatal error: this one proposal is refused with the reason
			// printed, and the next one is still owed its plan.
			log.Printf("token %s: position read failed (%s)", p.TokenID, why)
		}
		plan := execution.PlanLPAction(p, byToken[p.TokenID], pos, venues.PositionManager, out.DeadlineUnix)
		if plan.Refusal != "" {
			out.Refused++
			log.Printf("token %s (agent %s, %s): REFUSED — %s", plan.TokenID, plan.AgentID, plan.Recommendation, plan.Refusal)
		} else {
			out.Planned++
			names := make([]string, 0, len(plan.Intents))
			for _, in := range plan.Intents {
				names = append(names, in.Intent)
			}
			log.Printf("token %s (agent %s, %s): would send %d intent(s) in order: %s",
				plan.TokenID, plan.AgentID, plan.Recommendation, len(plan.Intents), strings.Join(names, " -> "))
		}
		out.Plans = append(out.Plans, plan)
	}

	// All refusals are still exit 0 — a refused proposal is a recorded fact,
	// not a fault; the fault signal this binary does emit is being unable to
	// read the queue at all, above.
	log.Printf("%d planned, %d refused", out.Planned, out.Refused)
	writeSummary(out)
}

// readPosition fetches the live position. It never returns a fatal error: a
// position the chain cannot be read for refuses THAT proposal, with the
// endpoint's own reason, because a plan assembled from a guessed position is
// worse than no plan.
func readPosition(ctx context.Context, arb, tokenID string) (*execution.LPPositionRead, string) {
	url := arb + "/v1/arbitrage/lp/position?token_id=" + tokenID
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err.Error()
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error.Code != "" {
			return nil, e.Error.Code + ": " + e.Error.Message
		}
		return nil, fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	var out positionResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, "unreadable answer: " + err.Error()
	}
	return &out.Position, ""
}

func getJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d: %s", url, res.StatusCode, trim(string(body), 200))
	}
	return json.Unmarshal(body, out)
}

func writeSummary(out summary) {
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		log.Fatalf("write summary: %v", err)
	}
}

func trim(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
