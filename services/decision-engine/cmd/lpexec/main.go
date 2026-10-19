// Command lpexec turns the arbitrage loop's proposed LP actions into the exact
// signer intents they would need.
//
// TWO MODES, AND THE DEFAULT IS THE SAFE ONE:
//
//   - PLAN (default): prints the complete signer request bodies it would send.
//     No signer call, no broadcast, no writes, no credential. This is what the
//     timer runs.
//   - EXECUTE (LP_EXECUTE=1): claims each proposal, signs and broadcasts the
//     intents in order through the signer, waits for each receipt, and records
//     the outcome in lp_position_actions / lp_execution_steps. Requires
//     DATABASE_URL, SIGNER_URL, INTERNAL_API_KEY, EXECUTION_RPC_URLS and
//     EXECUTION_ALLOWLIST_FILE, and REFUSES to run when ARCANA_VERIFICATION is
//     set — the same guard the pacer and the guard carry, because this path
//     also spends.
//
// The sequence is the contract's: decrease → collect → burn → mint for a
// rebalance (the burn refuses while tokensOwed is non-zero, and the decrease is
// what credits it), collect → burn for a close.
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
	"github.com/arcana/decision-engine/internal/store"
)

// lpExecutionDeadline is how long the minted/decreased transactions may take to
// be mined before the position manager refuses them. In EXECUTE mode the value
// is computed immediately before the bodies are signed; this constant is what
// the plan mode prints so a review sees a complete request.
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
	Armed           bool                      `json:"armed"`
	Arbitrage       string                    `json:"arbitrage"`
	PositionManager string                    `json:"position_manager"`
	DeadlineUnix    int64                     `json:"deadline_unix"`
	Proposals       int                       `json:"proposals"`
	Planned         int                       `json:"planned"`
	Refused         int                       `json:"refused"`
	Plans           []execution.LPActionPlan  `json:"plans"`
	Executions      []execution.LPExecResult  `json:"executions,omitempty"`
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	arb := envOr("ARBITRAGE_URL", "http://127.0.0.1:8084")
	armed := os.Getenv("LP_EXECUTE") == "1"
	if armed {
		// A VERIFICATION MAY NOT SPEND. Same refusal the pacer and the guard
		// carry, in the binary rather than in the suite.
		if v := os.Getenv("ARCANA_VERIFICATION"); v != "" {
			log.Fatalf("refusing: ARCANA_VERIFICATION is set and LP_EXECUTE=1 would sign and broadcast real transactions")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var venues venuesResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/venues", &venues); err != nil {
		log.Fatalf("read venues: %v", err)
	}

	out := summary{
		Armed:           armed,
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

	if !armed {
		writeSummary(out)
		return
	}
	executePlans(out, byToken)
}

// executePlans runs the armed path: claim, sign, broadcast, record, finish.
func executePlans(out summary, byToken map[string]execution.LPRegistryRow) {
	broker, st, closeStore, err := armedDeps()
	if err != nil {
		log.Fatalf("arm: %v", err)
	}
	defer closeStore()

	// The execution budget is the whole run, not one step: up to four signed
	// transactions, each waiting for its own receipt.
	execCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	failed := 0
	for _, plan := range out.Plans {
		if plan.Refusal != "" {
			continue
		}
		row := byToken[plan.TokenID]
		claimed, err := st.ClaimLPAction(execCtx, plan.ActionID)
		if err != nil {
			log.Printf("ERROR claim action %d: %v", plan.ActionID, err)
			failed++
			continue
		}
		if !claimed {
			// Another runner got there first, or the loop superseded it. Not a
			// fault — but it is said out loud, because a proposal that stops
			// being proposed mid-flight should never be silent.
			log.Printf("action %d is no longer proposed — skipped", plan.ActionID)
			continue
		}

		log.Printf("action %d (token %s): executing %d intent(s)", plan.ActionID, plan.TokenID, len(plan.Intents))
		res := broker.ExecuteLPPlan(execCtx, plan.AgentID, row.Wallet, plan, func(sr execution.LPStepResult) {
			if err := st.RecordLPStep(execCtx, plan.ActionID, sr.Step, sr.Intent, sr.Status, sr.TxHash, sr.GasUsed, sr.Error); err != nil {
				log.Printf("ERROR record step %d of action %d: %v", sr.Step, plan.ActionID, err)
			}
		})
		status := "failed"
		if res.Status == "executed" {
			status = "executed"
		}
		if err := st.FinishLPAction(execCtx, plan.ActionID, status, res.Error); err != nil {
			log.Printf("ERROR finish action %d: %v", plan.ActionID, err)
			failed++
		}
		for _, sr := range res.Steps {
			detail := sr.TxHash
			if sr.Error != "" {
				detail = sr.Error
			}
			log.Printf("  step %d %s: %s %s", sr.Step, sr.Intent, sr.Status, detail)
		}
		if status == "executed" {
			log.Printf("action %d EXECUTED (%d step(s))", plan.ActionID, len(res.Steps))
		} else {
			log.Printf("action %d FAILED: %s", plan.ActionID, res.Error)
			failed++
		}
		out.Executions = append(out.Executions, *res)
	}
	writeSummary(out)
	if failed > 0 {
		// A failed action is exactly what OnFailure= exists to surface: the
		// record carries the detail, and the alert says somebody should read it.
		log.Fatalf("ERROR: %d LP action(s) did not execute", failed)
	}
}

// armedDeps builds what EXECUTE mode needs. Everything is REQUIRED: this is the
// path that signs and broadcasts, so a missing setting stands the run down
// before anything is claimed.
func armedDeps() (*execution.Broker, *store.Store, func(), error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return nil, nil, nil, fmt.Errorf("DATABASE_URL is required in EXECUTE mode")
	}
	key := os.Getenv("INTERNAL_API_KEY")
	if key == "" {
		return nil, nil, nil, fmt.Errorf("INTERNAL_API_KEY is required in EXECUTE mode")
	}
	allowlist := envOr("EXECUTION_ALLOWLIST_FILE", "/home/ubuntu/arcana/services/signer/allowlist/robinhood-mainnet.json")
	cfg, err := execution.LoadConfig(allowlist)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("execution allowlist %s: %w", allowlist, err)
	}
	rpc := execution.NewRPC(strings.Split(envOr("EXECUTION_RPC_URLS", "http://127.0.0.1:8545"), ","), 15*time.Second)
	signer := execution.NewSignerClient(
		envOr("SIGNER_URL", "http://127.0.0.1:8085"), key, execution.HTTPClient(30*time.Second))
	pool, err := store.NewPool(context.Background(), databaseURL)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("database: %w", err)
	}
	return execution.NewBroker(cfg, rpc, signer), store.New(pool), pool.Close, nil
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
