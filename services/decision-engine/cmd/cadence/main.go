// Command cadence advances a competition on a CONTINUOUS clock.
//
// WHAT THIS REPLACES, AND WHY IT IS A DIFFERENT PROGRAM
//
// The scheduler opened one tick per US TRADING DAY. It asked market-data what
// the most recent completed session was, and a closed market meant no tick.
// That was correct while the prices came from a vendor describing US sessions.
//
// Stock Tokens trade against a Uniswap pool that never closes. "Trading day"
// is not a concept that applies to them: there is no open, no close, no
// weekend and no holiday. A calendar-driven tick would stand still through
// two thirds of the week while the market it claims to measure kept moving.
//
// So this asks a different question. Not "has a session completed" but "has
// enough TIME passed since the last decision", and it takes its prices from
// the pool.
//
// THE FLOOR IS TECHNICAL, AND IT USED TO BE ARITHMETIC
//
// It was four hours, derived from the fee schedule. The arithmetic was right and
// the premise was wrong: it assumed DECIDING IS TRADING. It is not. Most
// decisions are holds, a hold pays no fee at all, and the measured rate on the
// first chain-backed agent was one trade in five decisions. The floor was
// charging agents that rarely transact for the sins of agents that frequently
// do.
//
// What actually bounds the two costs is now measured directly, which is both
// more accurate and more honest:
//
//	TRANSACTIONS  max_signatures_per_agent_per_day, refused at the one process
//	              that can sign
//	INFERENCE     a per-agent daily token budget in the decision engine; an
//	              agent that exhausts it stands down with a recorded reason
//
// So frequency is the owner's choice, and what remains here is the floor the
// DATA MODEL imposes rather than one a policy prefers.
//
// SIXTY SECONDS, and the number is not a taste. A pool snapshot is identified by
//
//	"pool-" + t.UTC().Format("20060102T1504Z")
//
// which has MINUTE resolution, and decisions.market_snapshot_ref is a foreign
// key into it. Two ticks inside one minute are two decisions claiming the same
// immutable description of the market. Below a minute the record stops being
// able to say what an agent saw.
//
// The old reasoning, kept because it is still true about FEES and still worth
// knowing when choosing an interval:
//
// Every decision that trades pays the pool fee: 5 bp on the tight pools, 30 bp
// on the rest. A round trip is therefore 10 to 60 bp of NAV, before slippage
// and before gas. At one decision per hour a fully-traded agent gives up
// roughly 0.1% to 0.6% per hour — 2.4% to 14% per day — and no edge survives
// that.
//
//	4h  ->  6 decisions/day  ->  0.6% to 3.6% daily cost IF EVERY ONE TRADES
//	1h  -> 24 decisions/day  ->  2.4% to 14%  daily cost IF EVERY ONE TRADES
//
// The capitals are where the old floor went wrong. Those figures describe an
// agent that trades on every tick, and nothing observed does. An owner choosing
// an interval should read them as the worst case they are, not as the cost of
// thinking.
//
// The floor is enforced here rather than documented, and enforced on the
// MEASURED age of the last tick rather than on the timer's schedule, so a
// misconfigured timer cannot produce sub-minute decisions. The timer decides how
// often this program looks; this program decides whether anything happens.
//
// IDEMPOTENT BY CONSTRUCTION. Two runs inside one interval do nothing the
// second time, and that matters more here than on a daily timer: a continuous
// cadence means retries overlap normal operation rather than being an
// exception.
//
// Usage: cadence -competition <id> [-interval 4h]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// MinInterval is the shortest cadence this program will accept.
//
// See above: a property of the snapshot identifier, not a policy. A deployment
// that changes the ref format to carry seconds may lower this; one that simply
// dislikes the number may not.
const MinInterval = time.Minute

type config struct {
	agentServiceURL   string
	decisionEngineURL string
	marketDataURL     string
	internalKey       string
}

type competition struct {
	ID             string   `json:"id"`
	SeasonID       string   `json:"seasonId"`
	Type           string   `json:"type"`
	ParticipantIDs []string `json:"participantIds"`
	Status         string   `json:"status"`
}

type tick struct {
	ID                string     `json:"id"`
	TickIndex         int        `json:"tickIndex"`
	Phase             string     `json:"phase"`
	MarketSnapshotRef string     `json:"marketSnapshotRef"`
	WindowStart       *time.Time `json:"windowStart"`
	ClosedAt          *time.Time `json:"closedAt"`
}

type poolTickResult struct {
	Ref        string            `json:"ref"`
	TickTime   time.Time         `json:"tick_time"`
	Source     string            `json:"source"`
	Symbols    int               `json:"symbols"`
	Disputed   []string          `json:"disputed"`
	Unrefereed []string          `json:"unrefereed"`
	Unreadable map[string]string `json:"unreadable"`
}

func main() {
	compID := flag.String("competition", "", "competition id to advance")
	interval := flag.Duration("interval", MinInterval, "minimum time between decisions")
	flag.Parse()

	if *compID == "" {
		log.Fatal("-competition is required")
	}
	if *interval < MinInterval {
		// FATAL, not clamped. Silently raising a number somebody set means the
		// system is running a cadence nobody chose, and the log line saying so
		// scrolls away. Refusing to start is the only version that gets read.
		log.Fatalf("interval %s is below the floor of %s. Pool snapshots are identified to the "+
			"MINUTE (pool-20060102T1504Z) and decisions reference them by that id, so two ticks "+
			"inside one minute would claim the same description of the market. This is a "+
			"property of the record, not a policy: raise the interval, or change the snapshot "+
			"ref format first.",
			*interval, MinInterval)
	}

	cfg := config{
		agentServiceURL:   envOr("AGENT_SERVICE_URL", "http://localhost:3001"),
		decisionEngineURL: envOr("DECISION_ENGINE_URL", "http://localhost:8081"),
		marketDataURL:     envOr("MARKET_DATA_URL", "http://localhost:8083"),
		internalKey:       os.Getenv("INTERNAL_API_KEY"),
	}
	if cfg.internalKey == "" {
		log.Fatal("INTERNAL_API_KEY is required: taking a pool tick is a machine-tier write")
	}

	// THE BUDGET FOR THE WHOLE TICK, and it has to accommodate the slowest
	// participant rather than the average one.
	//
	// Five minutes was ample while every agent settled in memory: load state,
	// decide, insert. A CHAIN-BACKED agent reads ten balances, may send an
	// approval, sends a swap, and waits for two receipts — the decision engine
	// allows it four minutes, alone. One such agent in a field of five would
	// have left under a minute for the other four, and the ones at the end of
	// the list would have been starved by a neighbour rather than by anything
	// wrong with them.
	//
	// Participants run sequentially, so this scales with how many of them can
	// reach the chain. Ten minutes covers one slow chain agent plus a field of
	// fast ones; a second chain agent needs this raised again, which is a
	// deliberate act and not a surprise.
	ctx, cancel := context.WithTimeout(context.Background(), envDuration("CADENCE_TICK_BUDGET", 10*time.Minute))
	defer cancel()
	now := time.Now().UTC()

	comp, err := getCompetition(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("load competition: %v", err)
	}

	// A VERIFICATION MAY NOT OPEN A TICK.
	//
	// On 2026-09-11 a suite ran this binary with a one-hour interval to prove
	// the four-hour floor refused it. That floor had been deliberately retired,
	// so nothing refused: a real tick opened, every participant decided, and the
	// chain-backed one bought $5.96 of MSFT. $0.079 of gas and fees, and a
	// position that could not be guarded.
	//
	// Opening a tick is not a per-agent act — it makes EVERY participant decide
	// at once — so there is nothing to narrow. A caller that says it is a
	// verification gets refused here, before the tick exists.
	//
	// Refused even when no participant holds a wallet: the cadence cannot know
	// what will be funded next week, and a rule that depends on today's balances
	// is a rule that quietly stops applying. The suites drive the floor and the
	// idempotence through this refusal, which is cheaper and cannot cost
	// anything.
	if os.Getenv("ARCANA_VERIFICATION") != "" {
		log.Fatalf("refusing: ARCANA_VERIFICATION is set and opening a tick on competition %s "+
			"would make all %d participants decide, which can broadcast transactions and spend "+
			"real funds. This refusal is in the binary rather than in the suite, because a suite "+
			"that has to remember is a suite that forgets — and one already did",
			*compID, len(comp.ParticipantIDs))
	}
	if comp.Status == "completed" {
		log.Printf("competition %s already completed; nothing to do", *compID)
		return
	}

	// --- an open tick is closed, not re-opened -------------------------------
	//
	// There is no human window on a continuous cadence. Human vs AI was a
	// format built around a daily tick that waited for people to submit; a
	// four-hourly clock running through the night is not something a person
	// participates in, and pretending otherwise would leave ticks open for
	// hours with nobody arriving.
	open, err := getOpenTick(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("get open tick: %v", err)
	}
	if open != nil && open.ID != "" {
		if err := closeTick(ctx, cfg, *compID); err != nil {
			log.Fatalf("close tick: %v", err)
		}
		log.Printf("tick %d closed for %s (was left open)", open.TickIndex, *compID)
		return
	}

	// --- the floor, measured against the record ------------------------------
	last, err := lastTickTime(ctx, cfg, *compID)
	if err != nil {
		log.Fatalf("read tick history: %v", err)
	}
	if last != nil {
		age := now.Sub(*last)
		if age < *interval {
			log.Printf("last decision was %s ago; the cadence is %s. Nothing to do "+
				"(next at ~%s).", age.Round(time.Minute), *interval,
				last.Add(*interval).Format(time.RFC3339))
			return
		}
		log.Printf("last decision %s ago, cadence %s — opening a tick", age.Round(time.Minute), *interval)
	} else {
		log.Printf("no previous tick for %s — opening the first", *compID)
	}

	// --- price from the chain ------------------------------------------------
	//
	// No fallback, exactly as with the vendor. A competition that pauses is
	// recoverable; agents scored against prices nobody observed are not.
	pt, err := takePoolTick(ctx, cfg)
	if err != nil {
		log.Fatalf("ERROR: could not read the pool: %v — no tick opened, competition paused", err)
	}
	log.Printf("pool tick %s: %d symbols (%d disputed, %d unrefereed, %d unreadable)",
		pt.Ref, pt.Symbols, len(pt.Disputed), len(pt.Unrefereed), len(pt.Unreadable))
	if len(pt.Disputed) > 0 {
		// Loud, and the tick still opens. A disputed symbol is evidence, not a
		// reason to withhold the tick from every other symbol.
		log.Printf("WARN: pool and Chainlink disagree on %v — those quotes are marked "+
			"disputed in the snapshot and carry both figures", pt.Disputed)
	}

	opened, err := startTick(ctx, cfg, *compID, pt.Ref)
	if err != nil {
		log.Fatalf("open tick: %v", err)
	}
	log.Printf("tick %d opened for %s on %s", opened.TickIndex, *compID, pt.Ref)

	// HUMAN PARTICIPANTS ARE SKIPPED, NOT FAILED.
	//
	// Human vs AI was built around one tick per trading day that stayed open
	// for an hour so a person could submit. A four-hourly clock running through
	// the night is not a format a person participates in — six decisions a day,
	// two of them while they are asleep — so this cadence does not wait for
	// anybody and does not pretend to.
	//
	// Calling the engine for a human-managed agent returns 422 telling you to
	// use the manual endpoint. Counting that as a failure would print an error
	// every four hours forever for a system behaving exactly as designed, which
	// is the permanent noise that teaches people to stop reading the journal.
	// The agent is NOT removed from the competition: it is a live participant
	// with a real record, and deleting it is not this program's call.
	ran, skipped, failed := 0, 0, 0
	for _, pid := range comp.ParticipantIDs {
		if human, err := agentIsHuman(ctx, cfg, pid); err == nil && human {
			skipped++
			continue
		}
		if err := runAgent(ctx, cfg, comp.SeasonID, pid, pt.Ref); err != nil {
			log.Printf("agent %s failed: %v", pid, err)
			failed++
			continue
		}
		ran++
	}
	if skipped > 0 {
		log.Printf("%d human-managed agent(s) skipped: a continuous cadence has no "+
			"submission window. See docs/cadence.md.", skipped)
	}
	log.Printf("%d agents executed, %d skipped, %d failed", ran, skipped, failed)

	if err := closeTick(ctx, cfg, *compID); err != nil {
		log.Fatalf("close tick: %v", err)
	}
	log.Printf("tick %d closed for %s", opened.TickIndex, *compID)

	// A tick where NOTHING ran is a fault, not a quiet success. It means every
	// agent errored, and exiting 0 would let OnFailure= stay silent while the
	// competition recorded a tick in which nobody decided anything.
	// Skipped agents do not count towards "somebody ran". A competition whose
	// only participants are human now produces empty ticks, and that should be
	// loud rather than quietly recorded as a tick in which nobody decided.
	if ran == 0 && (len(comp.ParticipantIDs)-skipped) > 0 {
		log.Fatalf("ERROR: tick %d opened and closed with NO agent executing (%d eligible participants, all failed)",
			opened.TickIndex, len(comp.ParticipantIDs)-skipped)
	}
	if ran == 0 && skipped > 0 {
		log.Fatalf("ERROR: tick %d has only human-managed participants (%d), so nothing decided. "+
			"A continuous cadence cannot run a human-vs-AI competition; move these agents to a "+
			"format that suits them or retire the competition.", opened.TickIndex, skipped)
	}
}

// lastTickTime returns when the most recent tick began, or nil if there is none.
//
// Reads the RECORD rather than a stored cursor. A cursor is a second source of
// truth that drifts the first time a tick is inserted by anything else, and
// this project has already retired one table that existed to hold exactly that.
func lastTickTime(ctx context.Context, cfg config, compID string) (*time.Time, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/ticks")
	if err != nil {
		return nil, err
	}
	var ticks []tick
	if err := json.Unmarshal(body, &ticks); err != nil {
		// Some endpoints wrap the list; try that shape before giving up.
		var wrapped struct {
			Ticks []tick `json:"ticks"`
			Items []tick `json:"items"`
		}
		if err2 := json.Unmarshal(body, &wrapped); err2 != nil {
			return nil, fmt.Errorf("decode ticks: %w", err)
		}
		ticks = wrapped.Ticks
		if len(ticks) == 0 {
			ticks = wrapped.Items
		}
	}
	var latest *time.Time
	for i := range ticks {
		ws := ticks[i].WindowStart
		if ws == nil {
			continue
		}
		if latest == nil || ws.After(*latest) {
			latest = ws
		}
	}
	return latest, nil
}

func takePoolTick(ctx context.Context, cfg config) (*poolTickResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.marketDataURL+"/internal/v1/market/ticks/pool", bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Key", cfg.internalKey)
	// Carried onward rather than assumed handled above: if a future path reaches
	// here under verification, the engine refuses per agent as well.
	if v := os.Getenv("ARCANA_VERIFICATION"); v != "" {
		req.Header.Set("X-Arcana-Verification", v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("market-data returned HTTP %d: %s", res.StatusCode, truncate(string(body), 300))
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

// agentIsHuman asks agent-service whether a participant is human-managed.
//
// An unreadable answer is treated as NOT human, so a transient failure sends
// the agent down the normal path and produces a real error, rather than
// silently skipping a real AI participant and recording a tick it missed.
func agentIsHuman(ctx context.Context, cfg config, agentID string) (bool, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/agents/"+agentID)
	if err != nil {
		return false, err
	}
	var a struct {
		StrategyType *string `json:"strategyType"`
	}
	if err := json.Unmarshal(body, &a); err != nil {
		return false, err
	}
	return a.StrategyType != nil && *a.StrategyType == "human", nil
}

func getCompetition(ctx context.Context, cfg config, id string) (*competition, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+id)
	if err != nil {
		return nil, err
	}
	var comp competition
	if err := json.Unmarshal(body, &comp); err != nil {
		return nil, fmt.Errorf("decode competition: %w", err)
	}
	return &comp, nil
}

func getOpenTick(ctx context.Context, cfg config, compID string) (*tick, error) {
	body, err := httpGet(ctx, cfg.agentServiceURL+"/v1/competitions/"+compID+"/tick/open")
	if err != nil {
		return nil, err
	}
	var wrapped struct {
		Tick *tick `json:"tick"`
	}
	if err := json.Unmarshal(body, &wrapped); err == nil && wrapped.Tick != nil {
		return wrapped.Tick, nil
	}
	var t tick
	if err := json.Unmarshal(body, &t); err != nil {
		return &tick{}, nil
	}
	return &t, nil
}

func startTick(ctx context.Context, cfg config, compID, ref string) (*tick, error) {
	payload, _ := json.Marshal(map[string]string{"marketSnapshotRef": ref})
	// INTERNAL tier. Opening a tick is a write to the record every score is
	// computed from, so it sits behind the internal key — /v1/competitions
	// exposes only the reads. The first run of this binary used the public
	// prefix and got a 404, which is the router being right.
	body, err := httpPost(ctx, cfg,
		cfg.agentServiceURL+"/internal/v1/competitions/"+compID+"/ticks", payload)
	if err != nil {
		return nil, err
	}
	var t tick
	if err := json.Unmarshal(body, &t); err != nil {
		return nil, fmt.Errorf("decode opened tick: %w", err)
	}
	return &t, nil
}

func closeTick(ctx context.Context, cfg config, compID string) error {
	_, err := httpPost(ctx, cfg,
		cfg.agentServiceURL+"/internal/v1/competitions/"+compID+"/ticks/close", []byte("{}"))
	return err
}

func runAgent(ctx context.Context, cfg config, seasonID, agentID, ref string) error {
	payload, _ := json.Marshal(map[string]string{
		"agent_id":            agentID,
		"season_id":           seasonID,
		"market_snapshot_ref": ref,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.decisionEngineURL+"/internal/v1/decisions/execute", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Key", cfg.internalKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, truncate(string(body), 200))
	}
	return nil
}

func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s: HTTP %d: %s", url, res.StatusCode, truncate(string(body), 200))
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
		return nil, fmt.Errorf("POST %s: HTTP %d: %s", url, res.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envDuration reads a Go duration, and REFUSES a malformed one rather than
// quietly using the fallback. A tick budget that silently reverted to its
// default because somebody typed "10min" would be a limit nobody could see.
func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Fatalf("%s=%q is not a duration (try 10m): %v", key, v, err)
	}
	return d
}
