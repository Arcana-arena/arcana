// Command pace asks every agent whose own clock has come round to decide.
//
// # WHAT THIS REPLACES, AND WHY THE OLD SHAPE HAD TO GO
//
// Deciding used to be a per-COMPETITION act. `cadence -competition <id>
// -interval 4h` opened a tick and every participant decided against it, so one
// interval — held in a systemd unit, chosen by an operator — governed every
// strategy in the room. An owner whose edge lasts an hour and an owner who wants
// a weekly rebalance were both given four hours, and neither was asked. Worse,
// an agent's first decision waited for the competition's next boundary, which is
// how an owner came to watch a funded agent do nothing for sixteen hours.
//
// Timing is part of a strategy. So the interval moved onto the agent
// (agents.cadence_seconds, migration 0054) and this program drives it.
//
// # THE COMPETITION TICK STAYS, AND STOPS BEING A GATE
//
// `cadence` still opens and closes a tick per competition, because the
// leaderboard wants a marked window with a price snapshot on it. What it no
// longer does is decide on anybody's behalf. Two programs calling the engine for
// the same agent would double its decisions and its fees, so there is exactly
// one caller: this one.
//
// # THE FLOOR IS THE DATA MODEL, NOT A POLICY
//
// Sixty seconds, enforced in the schema as a CHECK and in the API as a
// validator. A pool snapshot is identified by "pool-" +
// UTC "20060102T1504Z" — MINUTE resolution — and decisions.market_snapshot_ref
// is a foreign key into market_snapshots, so two decisions inside one minute are
// two decisions claiming the same immutable description of the market.
//
// What an agent spends on pool fees is its owner's to spend; the four-hour
// policy floor was retired before this because it assumed deciding is trading,
// when most decisions are holds and the measured rate was one trade in five.
// What bounds the platform is measured directly, per agent, at the process that
// can do the spending: the signer's daily signature cap and the engine's daily
// token budget.
//
// # MEASURED FROM THE RECORD
//
// agent-service answers "who is due" by comparing each agent's cadence against
// the timestamp of its LAST RECORDED DECISION — not a cursor, not this
// program's schedule. So a minute this program misses is picked up on the next
// one instead of shifting the whole series, and a decision written by any other
// path (the manual endpoint) counts as one.
//
// ONE SNAPSHOT PER RUN. Every agent due in the same minute decides against the
// same pool snapshot, which is not an economy: the snapshot ref resolves to the
// minute, so within one run there is only one description of the market that can
// honestly be referenced.
//
// Usage: pace   (no flags; the timer decides how often this looks)
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/arcana/decision-engine/internal/upstream"
)

type config struct {
	agentServiceURL   string
	decisionEngineURL string
	marketDataURL     string
	internalKey       string
}

type dueAgent struct {
	AgentID        string  `json:"agent_id"`
	SeasonID       string  `json:"season_id"`
	CadenceSeconds int     `json:"cadence_seconds"`
	LastDecisionAt *string `json:"last_decision_at"`
	AgeSeconds     *int64  `json:"age_seconds"`
}

type dueResponse struct {
	Count  int        `json:"count"`
	Agents []dueAgent `json:"agents"`
}

type poolTickResult struct {
	Ref         string   `json:"ref"`
	Symbols     int      `json:"symbols"`
	Disputed    []string `json:"disputed"`
	Unrefereed  []string `json:"unrefereed"`
	Unreadable  []string `json:"unreadable"`
}

// Per-agent budget. An LLM agent that has to think, price nine pools and
// possibly sign is slow; the whole run is bounded by the number of agents times
// this rather than by one flat deadline, so a busy minute does not cut off the
// last agent in the list.
const perAgentBudget = 150 * time.Second

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg := config{
		agentServiceURL:   envOr("AGENT_SERVICE_URL", "http://localhost:3001"),
		decisionEngineURL: envOr("DECISION_ENGINE_URL", "http://localhost:8081"),
		marketDataURL:     envOr("MARKET_DATA_URL", "http://localhost:8083"),
		internalKey:       os.Getenv("INTERNAL_API_KEY"),
	}
	if cfg.internalKey == "" {
		log.Fatal("INTERNAL_API_KEY is required: pacing an agent is a machine-tier write")
	}

	// A VERIFICATION MAY NOT PACE ANYBODY.
	//
	// The same refusal `cadence` carries, for the same reason and bought by the
	// same incident: on 2026-09-11 a suite drove the cadence to prove a floor
	// that had been retired, opened a real tick, and bought $5.96 of MSFT with
	// $0.079 of gas. Pacing is worse, not better — it needs no competition and
	// no tick, so there is nothing else standing in the way. A caller that says
	// it is a verification is refused here, before the due list is even read.
	if v := os.Getenv("ARCANA_VERIFICATION"); v != "" {
		log.Fatalf("refusing: ARCANA_VERIFICATION is set and pacing would make every agent whose " +
			"cadence has elapsed decide, which can broadcast transactions and spend real funds. " +
			"This refusal is in the binary rather than in the suite, because a suite that has to " +
			"remember is a suite that forgets — and one already did")
	}

	// Who is due. Asked of the service that owns the schema rather than computed
	// here: the exclusions (draft, verification, human, unseated) are rules that
	// already exist on that side, and a second spelling of them in Go would drift
	// — showing up as agents quietly not deciding, which is the fault this whole
	// program exists to end.
	listCtx, cancelList := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelList()
	due, err := dueAgents(listCtx, cfg)
	if err != nil {
		log.Fatalf("read the due list: %v — nothing was paced", err)
	}
	if len(due) == 0 {
		// The normal answer on most minutes. Said plainly and exited 0: a quiet
		// minute is not a fault, and treating it as one is how an alarm becomes
		// something people close without reading.
		log.Printf("no agent is due")
		return
	}
	log.Printf("%d agent(s) due", len(due))

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(len(due))*perAgentBudget)
	defer cancel()

	// ONE SNAPSHOT FOR THE WHOLE RUN, taken before the first agent decides. No
	// fallback if the pool cannot be read: an agent scored against a price
	// nobody observed is worse than an agent that decided a minute late.
	pt, err := takePoolTick(ctx, cfg)
	if err != nil {
		log.Fatalf("ERROR: could not read the pool: %v — no agent paced, the next run tries again", err)
	}
	log.Printf("pool snapshot %s: %d symbols (%d disputed, %d unrefereed, %d unreadable)",
		pt.Ref, pt.Symbols, len(pt.Disputed), len(pt.Unrefereed), len(pt.Unreadable))
	if len(pt.Disputed) > 0 {
		// Loud, and the run continues. A disputed symbol is evidence, marked on
		// the quote itself, not a reason to withhold every other symbol.
		log.Printf("WARN: pool and Chainlink disagree on %v — those quotes are marked disputed "+
			"in the snapshot and carry both figures", pt.Disputed)
	}

	ran, failed := 0, 0
	for _, a := range due {
		age := "never decided"
		if a.AgeSeconds != nil {
			age = fmt.Sprintf("%s since its last decision", time.Duration(*a.AgeSeconds)*time.Second)
		}
		if err := decide(ctx, cfg, a, pt.Ref); err != nil {
			// Per agent, and it does not stop the others. One agent's refusal —
			// an exhausted token budget, a wallet that cannot pay for gas — is
			// about that agent, and the next one in the list is owed its run.
			log.Printf("agent %s failed (cadence %ds, %s): %v", a.AgentID, a.CadenceSeconds, age, err)
			failed++
			continue
		}
		log.Printf("agent %s decided (cadence %ds, %s)", a.AgentID, a.CadenceSeconds, age)
		ran++
	}

	log.Printf("%d decided, %d failed, snapshot %s", ran, failed, pt.Ref)

	// EVERY AGENT FAILING IS A FAULT, exiting 0 over it is how it stays
	// invisible. One failing is the agent's business and is logged as such; all
	// of them failing is the platform's, and OnFailure= has to hear about it.
	if ran == 0 && failed > 0 {
		log.Fatalf("ERROR: %d agent(s) were due and NONE decided", failed)
	}
}

func dueAgents(ctx context.Context, cfg config) ([]dueAgent, error) {
	body, err := httpGet(ctx, cfg, cfg.agentServiceURL+"/internal/v1/agents/due")
	if err != nil {
		return nil, err
	}
	var out dueResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode due list: %w", err)
	}
	// The count is the service's own claim about its list; if the two disagree,
	// something is wrong with the answer and guessing which half to trust is how
	// a silent partial run happens.
	if out.Count != len(out.Agents) {
		return nil, fmt.Errorf("due list says count=%d but carries %d agent(s)", out.Count, len(out.Agents))
	}
	return out.Agents, nil
}

func takePoolTick(ctx context.Context, cfg config) (*poolTickResult, error) {
	body, err := httpPost(ctx, cfg, cfg.marketDataURL+"/internal/v1/market/ticks/pool", []byte("{}"))
	if err != nil {
		return nil, err
	}
	var out poolTickResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode pool tick: %w", err)
	}
	if out.Ref == "" {
		return nil, errors.New("pool tick returned no ref")
	}
	return &out, nil
}

// decide asks the engine for one decision, against the snapshot this run took
// and the season of the seat the agent holds.
func decide(ctx context.Context, cfg config, a dueAgent, ref string) error {
	payload, _ := json.Marshal(map[string]string{
		"agent_id":            a.AgentID,
		"season_id":           a.SeasonID,
		"market_snapshot_ref": ref,
	})
	agentCtx, cancel := context.WithTimeout(ctx, perAgentBudget)
	defer cancel()
	_, err := httpPost(agentCtx, cfg, cfg.decisionEngineURL+"/internal/v1/decisions/execute", payload)
	return err
}

func httpGet(ctx context.Context, cfg config, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// The due list is machine tier: it names every agent about to be asked to
	// spend money, which is not a public reading.
	req.Header.Set("X-Internal-Key", cfg.internalKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, upstream.From(http.MethodGet, url, res.StatusCode, body)
	}
	return body, nil
}

func httpPost(ctx context.Context, cfg config, url string, payload []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Key", cfg.internalKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, upstream.From(http.MethodPost, url, res.StatusCode, body)
	}
	return body, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
