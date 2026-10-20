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
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
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

// planResponse is the reviewed plan GET /v1/arbitrage/lp/plan answers with.
// PoolFee is in BASIS POINTS (the venue's fee_bps); the signer takes the fee
// TIER, which is bps × 100.
type planResponse struct {
	Symbol  string `json:"symbol"`
	Pool    string `json:"pool"`
	PoolFee int    `json:"pool_fee"`
	Token0  string `json:"token0"`
	Token1  string `json:"token1"`
	Plan    *struct {
		TickLower      int32  `json:"tick_lower"`
		TickUpper      int32  `json:"tick_upper"`
		Amount0Desired string `json:"amount0_desired"`
		Amount1Desired string `json:"amount1_desired"`
		Amount0Min     string `json:"amount0_min"`
		Amount1Min     string `json:"amount1_min"`
	} `json:"plan"`
}

type openStep struct {
	Step    int    `json:"step"`
	Intent  string `json:"intent"`
	Status  string `json:"status"`
	TxHash  string `json:"tx_hash,omitempty"`
	TokenID string `json:"token_id,omitempty"`
	Error   string `json:"error,omitempty"`
}

type openSummary struct {
	Opened  bool       `json:"opened"`
	AgentID string     `json:"agent_id"`
	Symbol  string     `json:"symbol"`
	Pool    string     `json:"pool"`
	TokenID string     `json:"token_id,omitempty"`
	TxHash  string     `json:"tx_hash,omitempty"`
	SizeUSD float64    `json:"size_usd"`
	CapUSD  float64    `json:"cap_usd"`
	Error   string     `json:"error,omitempty"`
	Steps   []openStep `json:"steps"`
}

type summary struct {
	Armed           bool                     `json:"armed"`
	Arbitrage       string                   `json:"arbitrage"`
	PositionManager string                   `json:"position_manager"`
	DeadlineUnix    int64                    `json:"deadline_unix"`
	Proposals       int                      `json:"proposals"`
	Planned         int                      `json:"planned"`
	Refused         int                      `json:"refused"`
	Plans           []execution.LPActionPlan `json:"plans"`
	Executions      []execution.LPExecResult `json:"executions,omitempty"`
}

// agentArbitrageEnabled asks the arbitrage service whether a creator has
// switched the feature on for this agent.
//
// AN ABSENT SETTING IS DISABLED, and so is an unreadable one: the caller gets
// an error and refuses. The only direction this function may fail in is "do not
// act" — a feature that gates somebody else's funds must never be enabled by a
// timeout.
func agentArbitrageEnabled(ctx context.Context, arb, agentID string) (bool, error) {
	var resp struct {
		Setting struct {
			AgentID string `json:"agent_id"`
			Enabled bool   `json:"enabled"`
			Exists  bool   `json:"exists"`
		} `json:"setting"`
	}
	path := arb + "/v1/arbitrage/agents/" + url.PathEscape(agentID) + "/settings"
	if err := getJSON(ctx, path, &resp); err != nil {
		return false, err
	}
	if resp.Setting.AgentID == "" {
		return false, fmt.Errorf("the settings answer named no agent")
	}
	return resp.Setting.Enabled, nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	openMode := flag.Bool("open", false, "open one new LP position through the signer (requires LP_EXECUTE=1 and LP_MAX_OPEN_USD)")
	openSymbol := flag.String("symbol", "", "symbol to open (with --open)")
	openSizeUSD := flag.Float64("size-usd", 0, "USD value of the new position (with --open)")
	openRangePct := flag.Float64("range-pct", 0.05, "range around the current tick, symmetric in price (with --open)")
	openSlippageBps := flag.Float64("slippage-bps", 50, "slippage floor for the mint amounts (with --open)")
	openAgent := flag.String("agent", "", "agent id whose wallet opens the position (with --open)")
	flag.Parse()

	arb := envOr("ARBITRAGE_URL", "http://127.0.0.1:8084")
	armed := os.Getenv("LP_EXECUTE") == "1"
	if *openMode && !armed {
		// Opening spends; it is armed by the same switch as the executor, so
		// there is one thing to audit rather than two.
		log.Fatalf("--open signs and broadcasts; set LP_EXECUTE=1 to arm it")
	}
	if armed {
		// A VERIFICATION MAY NOT SPEND. Same refusal the pacer and the guard
		// carry, in the binary rather than in the suite.
		if v := os.Getenv("ARCANA_VERIFICATION"); v != "" {
			log.Fatalf("refusing: ARCANA_VERIFICATION is set and LP_EXECUTE=1 would sign and broadcast real transactions")
		}
	}
	if *openMode {
		runOpen(arb, *openAgent, strings.ToUpper(strings.TrimSpace(*openSymbol)), *openSizeUSD, *openRangePct, *openSlippageBps)
		return
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
		// THE OPT-IN, CHECKED HERE TOO. The loop already refuses to propose a
		// rebalance for a disabled agent, so reaching this line with one means
		// the queue is older than the switch (or something wrote to it
		// directly). Either way: nothing that CREATES EXPOSURE is signed for an
		// agent whose creator has arbitrage switched OFF.
		//
		// HARVESTS AND CLOSES ARE NOT BLOCKED, on purpose — the wind-down rule
		// (migration 0069): collecting fees and burning an emptied position add
		// no exposure, and switching the feature off must not strand funds in a
		// pool. An unreadable setting refuses everything: "we could not find out"
		// must never sign.
		if p.Recommendation == "rebalance" {
			if ok, err := agentArbitrageEnabled(ctx, arb, p.AgentID); err != nil {
				out.Refused++
				log.Printf("token %s (agent %s, %s): REFUSED — the arbitrage setting could not be read: %v",
					p.TokenID, p.AgentID, p.Recommendation, err)
				continue
			} else if !ok {
				out.Refused++
				log.Printf("token %s (agent %s, %s): REFUSED — arbitrage is not enabled for this agent (the creator's setting); nothing was signed",
					p.TokenID, p.AgentID, p.Recommendation)
				continue
			}
		}

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

// runOpen opens one position: a reviewed plan, an explicit per-open cap, the
// signer, the broadcast, and the receipt. It is the only path that creates a
// position; everything afterwards is the registry loop and the executor.
//
// THE CAP IS REQUIRED AND CHECKED BEFORE ANYTHING IS SIGNED: LP_MAX_OPEN_USD is
// the owner's ceiling for this act, and an unset cap is a refusal rather than
// an unlimited one.
func runOpen(arb, agent, symbol string, sizeUSD, rangePct, slippageBps float64) {
	if agent == "" {
		log.Fatalf("--agent is required with --open: the position must belong to an agent's wallet")
	}
	if symbol == "" {
		log.Fatalf("--symbol is required with --open")
	}
	if !(sizeUSD > 0) {
		log.Fatalf("--size-usd must be positive")
	}
	capUSD, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("LP_MAX_OPEN_USD")), 64)
	if err != nil || capUSD <= 0 {
		log.Fatalf("LP_MAX_OPEN_USD is required for --open: no cap, no open")
	}
	if sizeUSD > capUSD {
		log.Fatalf("refusing: size %.2f exceeds the per-open cap LP_MAX_OPEN_USD=%.2f", sizeUSD, capUSD)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// THE OPT-IN COMES FIRST, BEFORE ANY PLAN IS BUILT. Opening creates new
	// exposure on the agent's own funds; if its creator has not switched
	// arbitrage on, there is nothing to review. An unreadable setting refuses:
	// the default when nobody can be asked is OFF, never "carry on".
	if ok, err := agentArbitrageEnabled(ctx, arb, agent); err != nil {
		log.Fatalf("could not read the arbitrage setting for agent %s: %v — refusing to open", agent, err)
	} else if !ok {
		log.Fatalf("refusing: arbitrage is not enabled for agent %s — its creator has not switched it on "+
			"(the agent's Arbitrage tab; an agent with no setting is DISABLED)", agent)
	}

	var venues venuesResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/venues", &venues); err != nil {
		log.Fatalf("read venues: %v", err)
	}
	if venues.PositionManager == "" {
		log.Fatalf("the arbitrage side has no position manager configured")
	}

	qs := url.Values{}
	qs.Set("symbol", symbol)
	qs.Set("size_usd", strconv.FormatFloat(sizeUSD, 'f', -1, 64))
	qs.Set("range_pct", strconv.FormatFloat(rangePct, 'f', -1, 64))
	qs.Set("slippage_bps", strconv.FormatFloat(slippageBps, 'f', -1, 64))
	var plan planResponse
	if err := getJSON(ctx, arb+"/v1/arbitrage/lp/plan?"+qs.Encode(), &plan); err != nil {
		log.Fatalf("read the plan: %v", err)
	}
	if plan.Plan == nil || plan.Token0 == "" || plan.Token1 == "" || plan.Pool == "" {
		log.Fatalf("the plan is incomplete; refusing to sign it")
	}
	if plan.Plan.TickLower >= plan.Plan.TickUpper {
		log.Fatalf("the plan's range is empty or inverted (%d >= %d)", plan.Plan.TickLower, plan.Plan.TickUpper)
	}
	if plan.PoolFee <= 0 {
		log.Fatalf("the plan names no pool fee")
	}
	d0, ok0 := new(big.Int).SetString(plan.Plan.Amount0Desired, 10)
	d1, ok1 := new(big.Int).SetString(plan.Plan.Amount1Desired, 10)
	if !ok0 || !ok1 || (d0.Sign() == 0 && d1.Sign() == 0) {
		log.Fatalf("the plan's amounts are not usable (%q, %q)", plan.Plan.Amount0Desired, plan.Plan.Amount1Desired)
	}

	wallet := signerWallet(ctx, agent)
	broker, st, closeStore, err := armedDeps()
	if err != nil {
		log.Fatalf("arm: %v", err)
	}
	defer closeStore()

	have0, err := broker.TokenBalanceOf(ctx, plan.Token0, wallet)
	if err != nil {
		log.Fatalf("read token0 balance: %v", err)
	}
	have1, err := broker.TokenBalanceOf(ctx, plan.Token1, wallet)
	if err != nil {
		log.Fatalf("read token1 balance: %v", err)
	}
	if have0.Cmp(d0) < 0 || have1.Cmp(d1) < 0 {
		log.Fatalf("the wallet cannot cover the mint: holds %s/%s and the plan needs %s/%s (token0/token1, base units)",
			have0, have1, d0, d1)
	}

	mint := execution.LPIntent{Intent: "lp_mint", Body: map[string]any{
		"amount":          "0",
		"router":          venues.PositionManager,
		"token_in":        plan.Token0,
		"token_out":       plan.Token1,
		"fee":             uint32(plan.PoolFee * 100), // basis points → fee tier
		"tick_lower":      plan.Plan.TickLower,
		"tick_upper":      plan.Plan.TickUpper,
		"amount0_desired": plan.Plan.Amount0Desired,
		"amount1_desired": plan.Plan.Amount1Desired,
		"amount0_min":     plan.Plan.Amount0Min,
		"amount1_min":     plan.Plan.Amount1Min,
		"deadline":        strconv.FormatInt(execution.LPPlanDeadline(time.Now()), 10),
	}}
	lp := execution.LPActionPlan{AgentID: agent, Recommendation: "open", Intents: []execution.LPIntent{mint}}
	log.Printf("opening %s for agent %s: $%.2f, range [%d,%d], fee tier %d",
		symbol, agent, sizeUSD, plan.Plan.TickLower, plan.Plan.TickUpper, plan.PoolFee*100)

	// The wallet is the signer's derivation, not a database record that could
	// have drifted; the signer re-checks ownership of everything it signs.
	res := broker.ExecuteLPPlan(ctx, agent, wallet, lp, nil)

	planJSON, _ := json.Marshal(plan)
	row := store.LPOpen{
		AgentID: agent, Symbol: symbol, Pool: plan.Pool,
		SizeUSD: sizeUSD, Plan: planJSON, Status: "failed", Error: res.Error,
	}
	out := openSummary{
		AgentID: agent, Symbol: symbol, Pool: plan.Pool,
		SizeUSD: sizeUSD, CapUSD: capUSD, Error: res.Error,
		Steps: []openStep{},
	}
	for _, sr := range res.Steps {
		out.Steps = append(out.Steps, openStep{
			Step: sr.Step, Intent: sr.Intent, Status: sr.Status,
			TxHash: sr.TxHash, TokenID: sr.TokenID, Error: sr.Error,
		})
		if sr.Intent == "lp_mint" {
			if sr.TxHash != "" {
				out.TxHash = sr.TxHash
			}
			if sr.TokenID != "" {
				out.TokenID = sr.TokenID
			}
		}
	}
	if res.Status == "executed" {
		out.Opened = true
		row.Status = "executed"
		row.TokenID = out.TokenID
		row.TxHash = out.TxHash
	}
	if err := st.RecordLPOpen(ctx, row); err != nil {
		log.Printf("ERROR record open: %v", err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		log.Printf("write summary: %v", err)
	}
	if !out.Opened {
		log.Fatalf("open failed: %s", res.Error)
	}
	log.Printf("opened position %s (tx %s); the registry discovers it within one LP_SYNC_INTERVAL", out.TokenID, out.TxHash)
}

// signerWallet asks the signer for the agent's wallet — the authoritative
// derivation, not a database record that could drift.
func signerWallet(ctx context.Context, agent string) string {
	base := envOr("SIGNER_URL", "http://127.0.0.1:8085")
	key := os.Getenv("INTERNAL_API_KEY")
	if key == "" {
		log.Fatalf("INTERNAL_API_KEY is required: reading a wallet is machine-tier information")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/internal/v1/signer/wallets/"+agent, nil)
	if err != nil {
		log.Fatalf("wallet request: %v", err)
	}
	req.Header.Set("X-Internal-Key", key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatalf("read wallet: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		log.Fatalf("read wallet: HTTP %d: %s", res.StatusCode, trim(string(body), 200))
	}
	var w struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(body, &w); err != nil || w.Address == "" {
		log.Fatalf("read wallet: unreadable answer")
	}
	return w.Address
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
