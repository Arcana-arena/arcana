// Command server runs the ARCANA Arbitrage scanner.
//
// It is a read-only market-intelligence service: it reads configured venues,
// estimates net profit, and records opportunities. It also keeps the LP
// position registry (lp_positions) in step with the chain, proposing the
// actions a position needs — and proposing only. IT SIGNS AND SENDS NOTHING.
// The same-chain go/no-go (docs/go-no-go-arbitrage.md, 2026-10-18) found no
// second venue with real liquidity, so the honest output today is "indicative,
// not executable"; this service is the foundation Phase 2/3 build on.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/config"
	"github.com/arcana/arbitrage/internal/engine"
	"github.com/arcana/arbitrage/internal/lp"
	"github.com/arcana/arbitrage/internal/registry"
	"github.com/arcana/arbitrage/internal/store"
	"github.com/arcana/internalauth"
)

var buildCommit = "unknown"

const defaultRPC = "https://robinhood-rpc.publicnode.com," +
	"https://robinhood.api.pocket.network," +
	"https://rpc-robinhood.blockmachine.io," +
	"https://rpc.mainnet.chain.robinhood.com"

type server struct {
	engine *engine.Engine
	cfg    *config.Config
	chain  *chain.Client
	lpreg  *registry.Syncer
}

func main() {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8084"
	}

	allowlistFile := envOr("ARBITRAGE_ALLOWLIST_FILE", "../signer/allowlist/robinhood-mainnet.json")
	configFile := envOr("ARBITRAGE_CONFIG_FILE", "config/robinhood-arbitrage.json")

	cfg, err := config.Load(allowlistFile, configFile)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("arbitrage config: chain %d, %d tokens, min_net_profit_bps %.1f",
		cfg.ChainID, len(cfg.Tokens), cfg.MinNetProfitBps)

	rpcURLs := strings.Split(envOr("ARBITRAGE_RPC_URLS", defaultRPC), ",")
	chainClient := chain.NewClient(rpcURLs)

	pool, err := store.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	st := store.New(pool)
	srv := &server{
		engine: engine.New(chainClient, cfg, st),
		cfg:    cfg,
		chain:  chainClient,
		lpreg:  registry.New(chainClient, st, cfg),
	}

	guard := internalauth.New("arbitrage")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"arbitrage","commit":"%s"}`, buildCommit)
	})
	mux.HandleFunc("GET /v1/arbitrage/venues", srv.handleVenues)
	mux.HandleFunc("GET /v1/arbitrage/opportunities", srv.handleOpportunities)
	mux.HandleFunc("GET /v1/arbitrage/opportunities/history", srv.handleHistory)
	mux.HandleFunc("GET /v1/arbitrage/lp/plan", srv.handleLPPlan)
	mux.HandleFunc("GET /v1/arbitrage/lp/position", srv.handleLPPosition)
	mux.HandleFunc("GET /v1/arbitrage/lp/positions", srv.handleLPPositions)
	mux.HandleFunc("GET /v1/arbitrage/lp/actions", srv.handleLPActions)
	mux.HandleFunc("GET /v1/arbitrage/lp/executions", srv.handleLPExecutions)
	mux.HandleFunc("GET /v1/arbitrage/lp/opens", srv.handleLPOpens)
	// THE OPT-IN, read publicly and written by agent-service (which is where
	// ownership is checked). An absent row means disabled — see migration 0069.
	mux.HandleFunc("GET /v1/arbitrage/agents/settings", srv.handleAgentSettingsList)
	mux.HandleFunc("GET /v1/arbitrage/agents/{agent_id}/settings", srv.handleAgentSetting)
	mux.HandleFunc("POST /internal/v1/arbitrage/scan", guard.Wrap(srv.handleScan))
	mux.HandleFunc("POST /internal/v1/arbitrage/lp/sync", guard.Wrap(srv.handleLPSync))
	mux.HandleFunc("POST /internal/v1/arbitrage/agents/{agent_id}/settings", guard.Wrap(srv.handleSetAgentSetting))

	// The continuous scanner. Disabled by an empty or invalid SCAN_INTERVAL, so
	// the service can run as a pure HTTP API (or under a systemd timer) without
	// a background loop when that is the operator's choice.
	if d := scanInterval(); d > 0 {
		go srv.runScanner(d)
	} else {
		log.Printf("arbitrage background scanner DISABLED (SCAN_INTERVAL=%q)", os.Getenv("SCAN_INTERVAL"))
	}

	// The LP registry loop. Same disabling rule, its own interval: positions
	// move slower than quotes, so the default is minutes, not seconds. Like the
	// scanner it proposes and never executes.
	if d := lpSyncInterval(); d > 0 {
		go srv.runLPSync(d)
	} else {
		log.Printf("arbitrage LP registry loop DISABLED (LP_SYNC_INTERVAL=%q)", os.Getenv("LP_SYNC_INTERVAL"))
	}

	log.Printf("arbitrage listening on :%s", port)
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func (s *server) handleVenues(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg)
}

func (s *server) handleOpportunities(w http.ResponseWriter, r *http.Request) {
	rows, err := s.engine.Latest(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "opportunities_unavailable", err.Error())
		return
	}
	if rows == nil {
		rows = []store.OpportunityRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"opportunities": rows})
}

func (s *server) handleHistory(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.engine.Recent(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "history_unavailable", err.Error())
		return
	}
	if rows == nil {
		rows = []store.OpportunityRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"opportunities": rows})
}

func (s *server) handleScan(w http.ResponseWriter, r *http.Request) {
	res, err := s.engine.ScanOnce(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "scan_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleLPPlan turns a live pool state into a concrete lp_mint plan: the range
// snapped to the pool's tick spacing, and the two amounts sized for a target
// USD value. READ-ONLY — it builds the plan but sends nothing to the signer.
//
//	GET /v1/arbitrage/lp/plan?symbol=NVDA&size_usd=500&range_pct=0.05&slippage_bps=50
func (s *server) handleLPPlan(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	symbol := strings.ToUpper(strings.TrimSpace(q.Get("symbol")))
	if symbol == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "symbol is required, e.g. ?symbol=NVDA")
		return
	}
	sizeUSD := floatDefault(q.Get("size_usd"), 500)
	rangePct := floatDefault(q.Get("range_pct"), 0.05)
	slippageBps := floatDefault(q.Get("slippage_bps"), 50)

	var tok *config.Token
	for i := range s.cfg.Tokens {
		if s.cfg.Tokens[i].Symbol == symbol {
			tok = &s.cfg.Tokens[i]
			break
		}
	}
	if tok == nil {
		writeError(w, http.StatusNotFound, "unknown_symbol", "no token "+symbol+" in the venue config")
		return
	}
	var venue *config.Venue
	for i := range tok.Venues {
		if tok.Venues[i].ID == "uniswap-v3" {
			venue = &tok.Venues[i]
			break
		}
	}
	if venue == nil {
		writeError(w, http.StatusUnprocessableEntity, "no_v3_venue", symbol+" has no uniswap-v3 traded pool")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sqrtX96, tick, err := s.chain.Slot0(ctx, venue.Pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pool_unreadable", err.Error())
		return
	}
	spacing, err := s.chain.TickSpacing(ctx, venue.Pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pool_unreadable", err.Error())
		return
	}
	token0, err := s.chain.Token0(ctx, venue.Pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pool_unreadable", err.Error())
		return
	}

	// One side of every pool here is USDG ($1); the other side's USD price is
	// the pool's own quote for it. Which side is token0 is read, never assumed.
	usdg := s.cfg.QuoteToken
	var dec0, dec1 int
	var usd0, usd1 float64
	token1 := tok.Address
	if strings.EqualFold(token0, usdg.Address) {
		dec0, usd0 = usdg.Decimals, 1
		dec1 = tok.Decimals
		usd1, err = s.chain.PoolPrice(ctx, venue.Pool, tok.Address, tok.Decimals, usdg.Decimals)
	} else {
		dec1, usd1 = usdg.Decimals, 1
		dec0 = tok.Decimals
		usd0, err = s.chain.PoolPrice(ctx, venue.Pool, tok.Address, tok.Decimals, usdg.Decimals)
		token1 = usdg.Address
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "price_unreadable", err.Error())
		return
	}

	plan, err := lp.PlanFromState(lp.PoolState{
		SqrtPriceX96: sqrtX96,
		Tick:         tick,
		TickSpacing:  int32(spacing),
		Token0:       token0,
		Token1:       token1,
		Dec0:         dec0,
		Dec1:         dec1,
		Token0USD:    usd0,
		Token1USD:    usd1,
	}, sizeUSD, rangePct, slippageBps)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "plan_failed", err.Error())
		return
	}

	// The range in the STOCK token's USD price, which is what a reader means by
	// "±5% around $216". The pool ratio moves opposite to token0's price when
	// the stock is token0, so the inversion is explicit rather than assumed.
	sqrtP := plan.SqrtPrice
	sqrtPa := lp.TickToSqrtPrice(plan.TickLower)
	sqrtPb := lp.TickToSqrtPrice(plan.TickUpper)
	var stockNow, stockLower, stockUpper float64
	if strings.EqualFold(token0, usdg.Address) {
		stockNow = usd1
		stockLower = usd1 * math.Pow(sqrtPa/sqrtP, 2)
		stockUpper = usd1 * math.Pow(sqrtPb/sqrtP, 2)
	} else {
		stockNow = usd0
		stockLower = usd0 * math.Pow(sqrtP/sqrtPa, 2)
		stockUpper = usd0 * math.Pow(sqrtP/sqrtPb, 2)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"symbol":                symbol,
		"pool":                  venue.Pool,
		"pool_fee":              venue.FeeBps,
		"token0":                token0,
		"token1":                token1,
		"token0_decimals":       dec0,
		"token1_decimals":       dec1,
		"token0_usd":            usd0,
		"token1_usd":            usd1,
		"stock_price_usd":       stockNow,
		"stock_range_lower_usd": stockLower,
		"stock_range_upper_usd": stockUpper,
		"plan":                  plan,
		"note": "read-only plan. Send to the signer as intent lp_mint: token_in=token0, " +
			"token_out=token1, router=NonfungiblePositionManager, fee from the pool, " +
			"tick_lower/tick_upper and the four amounts from plan.",
	})
}

// handleLPPosition reads one position NFT and reports whether it is still in
// range, what it currently holds, and the read-only recommendation. It never
// harvests or rebalances — those need the collect/decrease/burn shapes, which
// the signer does not build yet.
//
//	GET /v1/arbitrage/lp/position?token_id=123
func (s *server) handleLPPosition(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimSpace(r.URL.Query().Get("token_id"))
	if idStr == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "token_id is required")
		return
	}
	tokenID, ok := new(big.Int).SetString(idStr, 10)
	if !ok || tokenID.Sign() <= 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "token_id must be a positive integer")
		return
	}
	npm := s.cfg.PositionManager
	if npm == "" {
		writeError(w, http.StatusInternalServerError, "position_manager_unconfigured",
			"position_manager is not set in the arbitrage config")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	pos, err := s.chain.Position(ctx, npm, tokenID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "position_unreadable", err.Error())
		return
	}
	// The owner is informational: a position can still be read and valued when
	// ownerOf fails, and losing the label is better than losing the position.
	owner, _ := s.chain.OwnerOf(ctx, npm, tokenID)

	pool, err := s.chain.GetPool(ctx, s.cfg.V3Factory, pos.Token0, pos.Token1, pos.Fee)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pool_unreadable", err.Error())
		return
	}
	if pool == "" {
		writeError(w, http.StatusUnprocessableEntity, "no_pool",
			"the position's pair has no pool at its fee tier")
		return
	}

	sqrtX96, currentTick, err := s.chain.Slot0(ctx, pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pool_unreadable", err.Error())
		return
	}

	// The exact fee accrual: the stored tokensOwed plus everything earned
	// since the position was last touched, recomputed the same way the
	// contract recomputes it at collect(). The pool cannot be read partially
	// for this — a wrong number here is worse than a refusal — so any of the
	// four fee-growth reads failing is an error, not a degraded answer.
	fg0, fg1, err := s.chain.FeeGrowthGlobal(ctx, pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "fee_growth_unreadable", err.Error())
		return
	}
	lower0, lower1, err := s.chain.TickFeeGrowthOutside(ctx, pool, pos.TickLower)
	if err != nil {
		writeError(w, http.StatusBadGateway, "fee_growth_unreadable", err.Error())
		return
	}
	upper0, upper1, err := s.chain.TickFeeGrowthOutside(ctx, pool, pos.TickUpper)
	if err != nil {
		writeError(w, http.StatusBadGateway, "fee_growth_unreadable", err.Error())
		return
	}
	inside0 := lp.FeeGrowthInside(fg0, lower0, upper0, currentTick, pos.TickLower, pos.TickUpper)
	inside1 := lp.FeeGrowthInside(fg1, lower1, upper1, currentTick, pos.TickLower, pos.TickUpper)
	fees0 := lp.FeesOwed(pos.Liquidity, pos.FeeGrowthInside0LastX128, inside0, pos.TokensOwed0)
	fees1 := lp.FeesOwed(pos.Liquidity, pos.FeeGrowthInside1LastX128, inside1, pos.TokensOwed1)

	inRange := lp.InRange(currentTick, pos.TickLower, pos.TickUpper)
	a0, a1 := lp.PositionValue(pos.Liquidity, pos.TickLower, pos.TickUpper, sqrtX96)

	writeJSON(w, http.StatusOK, map[string]any{
		"pool": pool,
		"position": lp.PositionState{
			TokenID:        tokenID.String(),
			Owner:          owner,
			Token0:         pos.Token0,
			Token1:         pos.Token1,
			Fee:            pos.Fee,
			TickLower:      pos.TickLower,
			TickUpper:      pos.TickUpper,
			Liquidity:      pos.Liquidity.String(),
			TokensOwed0:    pos.TokensOwed0.String(),
			TokensOwed1:    pos.TokensOwed1.String(),
			FeesOwed0:      fees0.String(),
			FeesOwed1:      fees1.String(),
			CurrentTick:    currentTick,
			InRange:        inRange,
			Amount0:        a0.String(),
			Amount1:        a1.String(),
			Recommendation: lp.Recommend(inRange, pos.Liquidity),
		},
		"note": "read-only. fees_owed0/1 are the exact current accrual, recomputed from the pool's " +
			"feeGrowth counters the same way collect() does; tokens_owed0/1 are only what the position " +
			"manager stored at the last touch. Harvest/decrease/burn are not signed by this service yet.",
	})
}

func (s *server) runScanner(d time.Duration) {
	log.Printf("arbitrage background scanner started (interval %s)", d)
	// Scan immediately so a fresh scanner has a heartbeat and rows without
	// waiting a full interval.
	s.scanNow()
	t := time.NewTicker(d)
	defer t.Stop()
	for range t.C {
		s.scanNow()
	}
}

func (s *server) scanNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	res, err := s.engine.ScanOnce(ctx)
	if err != nil {
		log.Printf("arbitrage scan: %v", err)
		return
	}
	log.Printf("arbitrage scan: %d opportunities, %d errors", res.Opportunities, res.Errors)
}

// handleLPPositions lists the registry: what agents own and the state last
// read from the chain. status=open (default), closed, or anything for both.
//
//	GET /v1/arbitrage/lp/positions?status=open&limit=100
func (s *server) handleLPPositions(w http.ResponseWriter, r *http.Request) {
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if status == "" {
		status = "open"
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 100)
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.lpreg.Positions(r.Context(), status, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "positions_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"positions": rows})
}

// handleLPActions lists the outstanding proposals — what the loop would ask
// the signer for. READ-ONLY: nothing executes these rows today.
//
//	GET /v1/arbitrage/lp/actions?limit=50
func (s *server) handleLPActions(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.lpreg.ProposedActions(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "actions_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"actions": rows,
		"note": "proposed actions only. Nothing executes them: no ARCANA code path calls " +
			"the signer's lp_collect/lp_decrease/lp_burn/lp_mint shapes yet.",
	})
}

// uuidish is the shape Postgres will accept for a uuid column. A malformed id
// has to be a 400 here: passing it through would turn a bad request into a 500
// from the database, and a 500 reads as "the service is broken".
var uuidish = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// handleAgentSettingsList lists the arbitrage switches a creator has touched.
// READ-ONLY, public: an agent with no row here is disabled, and the note says
// so rather than leaving an empty list to be read as "nobody decides anything".
//
//	GET /v1/arbitrage/agents/settings?limit=200
func (s *server) handleAgentSettingsList(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 200)
	if limit < 1 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.lpreg.AllAgentSettings(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "settings_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": rows,
		"note": "arbitrage is opt-in per agent. An agent with no row here is DISABLED: " +
			"an absent row and enabled=false mean the same thing.",
	})
}

// handleAgentSetting reads one agent's switch. A missing row answers 200 with
// enabled=false and exists=false — the default, not a 404.
//
//	GET /v1/arbitrage/agents/{agent_id}/settings
func (s *server) handleAgentSetting(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agent_id")
	if !uuidish.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid_agent_id", "agent_id must be a UUID")
		return
	}
	set, err := s.lpreg.AgentSetting(r.Context(), id)
	if err != nil && !errors.Is(err, store.ErrNoSetting) {
		writeError(w, http.StatusInternalServerError, "settings_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"setting": set})
}

// handleSetAgentSetting writes one agent's switch. MACHINE TIER (X-Internal-Key)
// and called by agent-service, which is the only place that knows whether the
// caller owns the agent.
//
//	POST /internal/v1/arbitrage/agents/{agent_id}/settings
//	{"enabled": true, "actor": "0x…"}
func (s *server) handleSetAgentSetting(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agent_id")
	if !uuidish.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid_agent_id", "agent_id must be a UUID")
		return
	}
	var body struct {
		Enabled *bool  `json:"enabled"`
		Actor   string `json:"actor"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "a JSON body with enabled and actor is required")
		return
	}
	if body.Enabled == nil {
		// A missing field is not false: writing the wrong state for somebody's
		// agent because a field was omitted is exactly what this guard prevents.
		writeError(w, http.StatusBadRequest, "enabled_required", "enabled must be true or false, explicitly")
		return
	}
	if strings.TrimSpace(body.Actor) == "" {
		writeError(w, http.StatusBadRequest, "actor_required",
			"actor is required: a switch about somebody's funds has to have a name against it")
		return
	}
	set, err := s.lpreg.SetAgentSetting(r.Context(), id, *body.Enabled, body.Actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "settings_write_failed", err.Error())
		return
	}
	log.Printf("arbitrage settings: agent %s enabled=%v by %s", id, set.Enabled, set.UpdatedBy)
	writeJSON(w, http.StatusOK, map[string]any{"setting": set})
}

// handleLPExecutions lists the latest recorded execution steps — what the executor signed, sent and was answered with, newest first. READ-ONLY.
//
//	GET /v1/arbitrage/lp/executions?limit=50
func (s *server) handleLPExecutions(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.lpreg.Executions(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "executions_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"executions": rows})
}

// handleLPOpens lists the latest position opens — which agent, which plan,
// what size, which tokenId and transaction. READ-ONLY.
//
//	GET /v1/arbitrage/lp/opens?limit=50
func (s *server) handleLPOpens(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.lpreg.Opens(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "opens_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opens": rows})
}

// handleLPSync runs one registry pass now — for the verification suite, and
// for an operator who does not want to wait for the interval. Authed like the
// scan trigger; a pass already running answers 409 rather than queueing.
func (s *server) handleLPSync(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	res, err := s.lpreg.SyncOnce(ctx)
	if errors.Is(err, registry.ErrBusy) {
		writeError(w, http.StatusConflict, "sync_busy", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lp_sync_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) runLPSync(d time.Duration) {
	log.Printf("arbitrage LP registry loop started (interval %s)", d)
	// Sync immediately so a fresh loop has a heartbeat without waiting a full
	// interval — the same rule the scanner follows.
	s.lpSyncNow()
	t := time.NewTicker(d)
	defer t.Stop()
	for range t.C {
		s.lpSyncNow()
	}
}

func (s *server) lpSyncNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	res, err := s.lpreg.SyncOnce(ctx)
	if err != nil {
		log.Printf("lp sync: %v", err)
		return
	}
	log.Printf("lp sync: %d watched, %d synced, %d discovered, %d proposed, %d closed, %d open, %d errors",
		res.Watched, res.Synced, res.Discovered, res.Proposed, res.Closed, res.Open, res.Errors)
}

func scanInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("SCAN_INTERVAL"))
	if v == "" {
		return 60 * time.Second
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0
	}
	return d
}

// lpSyncInterval reads LP_SYNC_INTERVAL. Empty means the reviewed default (5
// minutes: positions move on the scale of price ranges, not quotes, and each
// pass is a handful of chain reads); invalid or non-positive disables the loop
// so the service can run as a pure HTTP API.
func lpSyncInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("LP_SYNC_INTERVAL"))
	if v == "" {
		return 5 * time.Minute
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0
	}
	return d
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func floatDefault(s string, def float64) float64 {
	if strings.TrimSpace(s) == "" {
		return def
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return def
	}
	return v
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{
			"code":     errCode,
			"message":  message,
			"trace_id": "",
		},
	})
}
