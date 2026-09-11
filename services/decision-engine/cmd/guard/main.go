// Command guard watches protective levels between decision ticks.
//
// WHY IT IS A SEPARATE PROCESS AND NOT A CADENCE JOB
//
// Everything else that trades in this system runs on the decision cadence: a
// tick opens, the agent is asked, an answer is recorded. A stop loss cannot
// work that way. The entire value of one is that it fires BETWEEN ticks, and an
// agent on an hourly cadence with a 5% stop has, in practice, a 5%-plus-one-hour
// stop — which is not the thing its owner asked for.
//
// So this runs continuously, holds no model, and asks one question: has any
// armed level been crossed.
//
// WHAT IT COSTS WHEN NOTHING HAPPENS: one eth_call per armed guard per scan,
// and nothing else. No inference, no signature, no gas. An agent with no armed
// guard costs not even a row read. Gas is spent only when a level is actually
// crossed, and only after the position, the price and the cost budget have each
// been re-checked under an exclusive lease.
//
// SUPERVISION, because this project has a specific record here.
//
//	The go-run parent/child trap has bitten three times: `go run` compiles and
//	execs the server as a CHILD, so killing the parent leaves the child holding
//	its port. This is BUILT and run as a binary, and the systemd unit
//	supervises the process that actually does the work.
//
//	A watcher was once confirmed alive with `pgrep -f cycle-watch.sh`, which
//	matched the pgrep command's own argv. It had been dead for hours. So this
//	writes a HEARTBEAT to the database on every scan, including scans that find
//	nothing, and the check that it is alive reads that row — a fact this process
//	has to produce, which no checking command can produce for it.
//
//	A watchdog alarm path was once broken from the first line ever written,
//	and nobody knew because nothing had ever fired it.
//
// A DEAD WATCHER MUST NOT LOOK LIKE A QUIET ONE. docs/execution.md says this,
// and it is why the heartbeat is unconditional. Silence then means one thing
// only: the process is not running.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/arcana/decision-engine/internal/engine"
	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/marketdata"
	"github.com/arcana/decision-engine/internal/store"
)

// ScanInterval default, and why this number.
//
// It is bounded below by what a scan COSTS and above by what a stop loss is
// FOR. Below: one eth_call per armed guard, against an endpoint shared with
// execution — at fifteen seconds a book of ten guarded positions is 40 calls a
// minute, which is nothing, and at one second it is 600, which is rude to an
// endpoint the agents also need to trade through. Above: a stop loss checked
// every five minutes is a five-minute stop loss, and on a chain with 0.1s
// blocks that is most of a move.
//
// Fifteen seconds is 150 blocks. Configurable, because the right number depends
// on how many positions are guarded and nobody knows that number yet.
const defaultScanInterval = 15 * time.Second

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	dbURL := mustEnv("DATABASE_URL")
	interval := envDuration("GUARD_SCAN_INTERVAL", defaultScanInterval)
	version := os.Getenv("ARCANA_VERSION")
	if version == "" {
		version = "unknown"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := store.NewPool(ctx, dbURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()
	st := store.New(pool)
	eng := engine.New(st, marketdata.New(mustEnv("MARKET_DATA_URL")))

	// THE SAME BROKER THE DECISION PATH USES. Not a second, simpler client:
	// a protective exit goes through the same allowlist, the same signer and
	// the same execution recording as any other trade, and the only way to be
	// sure of that is for it to be the same code.
	broker, berr := buildBroker()
	if berr != nil {
		// REFUSE TO START rather than run as a watcher that can see a level
		// cross and do nothing about it. A process that watches and cannot act
		// is worse than no process: it looks like protection.
		log.Fatalf("chain execution is not configured, so this watcher could see a level cross "+
			"and do nothing about it: %v", berr)
	}
	eng = eng.WithBroker(broker)
	// THE COST METER, IF THE OWNER ASKED FOR ONE. Nothing is configured here: a
	// protective exit reads the same risk_profile the decision cycle reads, so
	// an agent with a cost brake has it applied to its exits too, and an agent
	// without one is not handed one by this process either.
	log.Printf("transaction cost meter: per agent, from risk_profile.cost_budget_monthly_pct")

	log.Printf("position guard starting: scanning every %s, version %s", interval, version)

	// A scan on the way in, so a restart is visible immediately in the
	// heartbeat rather than one interval later.
	scan(ctx, eng, st, version)

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("position guard stopping")
			return
		case <-t.C:
			scan(ctx, eng, st, version)
		}
	}
}

// scan runs one pass and ALWAYS writes a heartbeat.
//
// Including when the pass failed, and including when it found nothing. The
// heartbeat carries the error, so "the watcher is alive and every scan is
// failing" is a state that can be seen — as distinct from both "healthy" and
// "gone", which is the distinction this whole design turns on.
func scan(ctx context.Context, eng *engine.Engine, st *store.Store, version string) {
	// A scan is bounded so one wedged RPC call cannot stop every future scan.
	// The interval keeps its promise even when the chain does not.
	sctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()

	armed, fired, err := eng.ScanOnce(sctx)
	if err != nil {
		log.Printf("scan: %d armed, %d fired, first error: %v", armed, fired, err)
	} else if armed > 0 || fired > 0 {
		log.Printf("scan: %d armed, %d fired", armed, fired)
	}

	if herr := st.Heartbeat(context.WithoutCancel(sctx), armed, int64(fired), version, err); herr != nil {
		// A heartbeat that cannot be written is the one failure this process
		// cannot report through the heartbeat, so it goes to the journal at
		// ERROR and the unit's OnFailure is the backstop.
		log.Printf("ERROR heartbeat not written, so this watcher is about to look dead: %v", herr)
	}
}

func buildBroker() (*execution.Broker, error) {
	// THE SAME ENVIRONMENT VARIABLE NAMES the decision engine uses, so a guard
	// and an engine can never be pointed at different allowlists or different
	// signers by a deployment that set one and not the other.
	allowlist := os.Getenv("EXECUTION_ALLOWLIST_FILE")
	rpcs := os.Getenv("EXECUTION_RPC_URLS")
	signerURL := os.Getenv("SIGNER_URL")
	internalKey := os.Getenv("INTERNAL_API_KEY")
	if allowlist == "" || rpcs == "" || signerURL == "" || internalKey == "" {
		return nil, fmt.Errorf("SIGNER_URL, EXECUTION_ALLOWLIST_FILE, EXECUTION_RPC_URLS and " +
			"INTERNAL_API_KEY must all be set")
	}
	cfg, err := execution.LoadConfig(allowlist)
	if err != nil {
		return nil, err
	}
	urls := strings.Split(rpcs, ",")
	for i := range urls {
		urls[i] = strings.TrimSpace(urls[i])
	}
	rpc := execution.NewRPC(urls, 20*time.Second)
	signer := execution.NewSignerClient(signerURL, internalKey, execution.HTTPClient(120*time.Second))
	b := execution.NewBroker(cfg, rpc, signer)
	b.EthUSDFeed = envOr("EXECUTION_ETH_USD_FEED", "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9")
	log.Printf("execution allowlist: chain %d, %d tokens, router %s", cfg.ChainID, len(cfg.Tokens), cfg.Router())
	return b, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
		log.Printf("WARN: %s=%q is not a duration; using %s", k, v, def)
	}
	return def
}

