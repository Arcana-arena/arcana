// Package registry keeps the lp_positions registry in step with the chain.
//
// THE LOOP PROPOSES; IT DOES NOT EXECUTE. Every pass reads the chain and
// writes what it saw plus, when a position is out of range or empty, the
// action it would take as a `proposed` row in lp_position_actions. Nothing in
// this service can sign or send anything — the signer holds the keys and no
// service calls its lp_* shapes yet — so a proposal is a plan with a paper
// trail, not a queue with a worker.
//
// THE CHAIN IS THE SOURCE OF TRUTH. The registry rows are a cache: every one
// of them can be rebuilt by re-reading the position manager. Ownership is
// re-read (ownerOf) on every pass rather than remembered from the mint, and a
// position is only closed on positive evidence — a burned token (the position
// manager's zero struct) or an owner outside the agent wallet set. An
// unreadable chain is an error the pass reports, never a closure.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"sync/atomic"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/config"
	"github.com/arcana/arbitrage/internal/lp"
	"github.com/arcana/arbitrage/internal/store"
)

// discoveryWindowBlocks is the largest block span one Transfer-log query may
// cover. The reviewed endpoint refuses a recipient-filtered query spanning
// more than 100,000 blocks, so this stays under that with margin. It is a
// property of the providers this service actually calls, measured — not a
// preference.
const discoveryWindowBlocks = 90_000

// Chain is the read-only chain surface the syncer uses. It is an interface so
// the loop's decisions (close on a burn, refuse on unreadable ownership,
// propose on out-of-range) are testable without a network.
type Chain interface {
	BlockNumber(ctx context.Context) (int64, error)
	PositionTransfersTo(ctx context.Context, contract string, to []string, fromBlock, toBlock int64) ([]chain.TransferLog, error)
	Position(ctx context.Context, npm string, tokenID *big.Int) (*chain.Position, error)
	OwnerOf(ctx context.Context, npm string, tokenID *big.Int) (string, error)
	GetPool(ctx context.Context, factory, tokenA, tokenB string, fee uint32) (string, error)
	Slot0(ctx context.Context, pool string) (*big.Int, int32, error)
	TickSpacing(ctx context.Context, pool string) (int64, error)
	PoolPrice(ctx context.Context, pool, tokenAddr string, tokenDec, quoteDec int) (float64, error)
	FeeGrowthGlobal(ctx context.Context, pool string) (g0, g1 *big.Int, err error)
	TickFeeGrowthOutside(ctx context.Context, pool string, tick int32) (o0, o1 *big.Int, err error)
}

// Store is the persistence surface the syncer uses.
type Store interface {
	AllAgentWallets(ctx context.Context) ([]store.AgentWallet, error)
	OpenLPPositions(ctx context.Context) ([]store.LPPosition, error)
	UpsertLPPosition(ctx context.Context, p store.LPPosition) error
	CloseLPPosition(ctx context.Context, positionManager, tokenID string) error
	PendingActions(ctx context.Context, positionManager, tokenID string) ([]store.LPAction, error)
	SupersedeActions(ctx context.Context, positionManager, tokenID string) error
	ProposeAction(ctx context.Context, a store.LPAction) error
	LPHeartbeat(ctx context.Context, positions, actions int, discoveryBlock *int64, errMsg string) error
	DiscoveryBlock(ctx context.Context) (int64, bool, error)
	LPPositions(ctx context.Context, status string, limit int) ([]store.LPPosition, error)
	ProposedActions(ctx context.Context, limit int) ([]store.LPAction, error)
	RecentLPExecutions(ctx context.Context, limit int) ([]store.LPExecutionStep, error)
	RecentLPOpens(ctx context.Context, limit int) ([]store.LPOpen, error)
	// The opt-in: who may be given new exposure, and the owner's switch.
	EnabledAgentIDs(ctx context.Context) ([]string, error)
	AgentSetting(ctx context.Context, agentID string) (store.AgentSetting, error)
	SetAgentSetting(ctx context.Context, agentID string, enabled bool, actor string) (store.AgentSetting, error)
	AllAgentSettings(ctx context.Context, limit int) ([]store.AgentSetting, error)
}

// ErrBusy is returned when a pass is already running. The trigger endpoint and
// the background loop share one syncer, and two passes racing could propose
// the same action twice — so the second caller is turned away, not queued.
var ErrBusy = errors.New("an LP sync pass is already running")

// Syncer runs one sync pass at a time.
type Syncer struct {
	chain Chain
	store Store
	cfg   *config.Config

	running atomic.Bool
}

func New(c Chain, st Store, cfg *config.Config) *Syncer {
	return &Syncer{chain: c, store: st, cfg: cfg}
}

// Positions returns registry rows for the API. status is "open", "closed" or
// anything else for both.
func (s *Syncer) Positions(ctx context.Context, status string, limit int) ([]store.LPPosition, error) {
	return s.store.LPPositions(ctx, status, limit)
}

// ProposedActions returns the outstanding proposals — the read side of what the
// executor picks up, exposed so an operator can see it now.
func (s *Syncer) ProposedActions(ctx context.Context, limit int) ([]store.LPAction, error) {
	return s.store.ProposedActions(ctx, limit)
}

// Executions returns the latest recorded execution steps for the public
// activity feed.
func (s *Syncer) Executions(ctx context.Context, limit int) ([]store.LPExecutionStep, error) {
	return s.store.RecentLPExecutions(ctx, limit)
}

// Opens returns the latest recorded position opens for the public activity
// feed.
func (s *Syncer) Opens(ctx context.Context, limit int) ([]store.LPOpen, error) {
	return s.store.RecentLPOpens(ctx, limit)
}

// AgentSetting reads one agent's arbitrage switch. A missing row comes back as
// store.ErrNoSetting with Enabled=false — the default, not a failure.
func (s *Syncer) AgentSetting(ctx context.Context, agentID string) (store.AgentSetting, error) {
	return s.store.AgentSetting(ctx, agentID)
}

// SetAgentSetting writes the switch. The actor is recorded: this is a creator's
// decision about their agent's funds and it has to have a name against it.
func (s *Syncer) SetAgentSetting(ctx context.Context, agentID string, enabled bool, actor string) (store.AgentSetting, error) {
	return s.store.SetAgentSetting(ctx, agentID, enabled, actor)
}

// AllAgentSettings lists the switches that have been touched.
func (s *Syncer) AllAgentSettings(ctx context.Context, limit int) ([]store.AgentSetting, error) {
	return s.store.AllAgentSettings(ctx, limit)
}

// Result summarizes one pass.
type Result struct {
	Watched    int    `json:"watched"`
	Discovered int    `json:"discovered"`
	Synced     int    `json:"synced"`
	Skipped    int    `json:"skipped"`
	Proposed   int    `json:"proposed"`
	Closed     int    `json:"closed"`
	Open       int    `json:"open"`
	// Enabled is how many agents the creator has switched arbitrage on for.
	// Zero is a normal state, not an error: the feature is opt-in.
	Enabled int    `json:"enabled"`
	Errors  int    `json:"errors"`
	Note    string `json:"note,omitempty"`
}

// outcome is what one refresh did for a position. "Not an error" and "written"
// are different things: a discovered token that turns out not to belong to an
// agent wallet is skipped, not synced, and counting it as synced would hide
// that nothing was registered.
type outcome int

const (
	// outcomeSkipped: nothing was written — the token is not (or no longer)
	// an agent-owned position.
	outcomeSkipped outcome = iota
	// outcomeSynced: the registry row was written.
	outcomeSynced
	// outcomeClosed: a known row was closed (burned, or no longer agent-owned).
	outcomeClosed
)

// SyncOnce reads every open position, discovers new ones from Transfer logs,
// and keeps the proposals in step with the recommendations. The heartbeat is
// written even when the pass fails, so a loop that died is distinguishable
// from one that ran and found nothing.
func (s *Syncer) SyncOnce(ctx context.Context) (*Result, error) {
	npm := s.cfg.PositionManager
	if npm == "" {
		return nil, errors.New("position_manager is not set in the arbitrage config")
	}
	if !s.running.CompareAndSwap(false, true) {
		return nil, ErrBusy
	}
	defer s.running.Store(false)

	res := &Result{}
	firstErr := ""
	record := func(err error) {
		res.Errors++
		if firstErr == "" {
			firstErr = err.Error()
		}
		log.Printf("lp sync: %v", err)
	}

	wallets, err := s.store.AllAgentWallets(ctx)
	if err != nil {
		return nil, fmt.Errorf("agent wallets: %w", err)
	}
	byWallet := make(map[string]store.AgentWallet, len(wallets))
	addresses := make([]string, 0, len(wallets))
	for _, w := range wallets {
		byWallet[strings.ToLower(w.Address)] = w
		addresses = append(addresses, w.Address)
	}

	open, err := s.store.OpenLPPositions(ctx)
	if err != nil {
		return nil, fmt.Errorf("open positions: %w", err)
	}
	res.Watched = len(open)
	known := make(map[string]bool, len(open))
	for _, p := range open {
		known[p.TokenID] = true
	}

	// WHO MAY BE GIVEN NEW EXPOSURE. Read once per pass, and an unreadable set
	// is treated as EMPTY rather than as "everyone": the failure mode of a
	// settings read must be that nothing new is opened, never that everything
	// is. Harvests and closes still run for every agent (see refreshOne).
	enabled := map[string]bool{}
	if ids, err := s.store.EnabledAgentIDs(ctx); err != nil {
		record(fmt.Errorf("arbitrage settings: %w (treating every agent as disabled this pass)", err))
	} else {
		for _, id := range ids {
			enabled[id] = true
		}
	}
	res.Enabled = len(enabled)

	tally := func(o outcome, proposed bool) {
		switch o {
		case outcomeClosed:
			res.Closed++
		case outcomeSynced:
			res.Synced++
		case outcomeSkipped:
			res.Skipped++
		}
		if proposed {
			res.Proposed++
		}
	}
	for _, p := range open {
		o, proposed, err := s.refreshOne(ctx, npm, p, true, byWallet, enabled)
		if err != nil {
			record(err)
		}
		tally(o, proposed)
	}

	// Discovery: read Transfer logs from where the last pass stopped. The
	// cursor moves only over windows whose logs were actually read, so a
	// failure mid-scan resumes instead of skipping blocks.
	cursor, haveCursor, err := s.store.DiscoveryBlock(ctx)
	if err != nil {
		return nil, fmt.Errorf("discovery cursor: %w", err)
	}
	nextBlock, fresh, err := s.discover(ctx, npm, addresses, byWallet, known, cursor, haveCursor)
	if err != nil {
		record(err)
	}
	res.Discovered = len(fresh)
	res.Watched += len(fresh)
	for _, f := range fresh {
		o, proposed, err := s.refreshOne(ctx, npm, f, false, byWallet, enabled)
		if err != nil {
			record(err)
		}
		tally(o, proposed)
	}

	// The honest open count after the pass, read back rather than tallied.
	if openNow, err := s.store.OpenLPPositions(ctx); err == nil {
		res.Open = len(openNow)
	} else {
		record(err)
	}

	errMsg := ""
	if res.Errors > 0 {
		errMsg = fmt.Sprintf("%d errors; first: %s", res.Errors, firstErr)
		res.Note = errMsg
	}
	if err := s.store.LPHeartbeat(ctx, res.Open, res.Proposed, &nextBlock, errMsg); err != nil {
		log.Printf("lp heartbeat: %v", err)
		res.Errors++
	}
	return res, nil
}

// discover reads Transfer logs from cursor to the chain head and returns the
// cursor to persist plus any tokenIds that are not in the registry yet. A
// failed window leaves the cursor at that window's first block — the next pass
// reads it again rather than moving past it.
//
// On the very first pass there is no cursor, and the loop starts from the head
// forward. No position can predate it: a position NFT can only be minted by
// whoever holds an agent wallet's key — that is the signer — and no code path
// calls its lp_mint shape yet. If that changes, backfill is a deliberate job
// against the same Transfer logs, not something this loop guesses at.
func (s *Syncer) discover(ctx context.Context, npm string, wallets []string, byWallet map[string]store.AgentWallet, known map[string]bool, cursor int64, haveCursor bool) (int64, []store.LPPosition, error) {
	head, err := s.chain.BlockNumber(ctx)
	if err != nil {
		return cursor, nil, fmt.Errorf("block number: %w", err)
	}
	if !haveCursor {
		return head + 1, nil, nil
	}
	if len(wallets) == 0 {
		if head+1 > cursor {
			cursor = head + 1
		}
		return cursor, nil, nil
	}
	var fresh []store.LPPosition
	seen := map[string]bool{}
	for from := cursor; from <= head; from += discoveryWindowBlocks {
		to := from + discoveryWindowBlocks - 1
		if to > head {
			to = head
		}
		logs, err := s.chain.PositionTransfersTo(ctx, npm, wallets, from, to)
		if err != nil {
			return from, fresh, fmt.Errorf("transfer logs %d..%d: %w", from, to, err)
		}
		for _, l := range logs {
			if l.TokenID == nil || l.TokenID.Sign() <= 0 {
				return from, fresh, fmt.Errorf("transfer in %d..%d has no token id", from, to)
			}
			id := l.TokenID.String()
			if known[id] || seen[id] {
				continue
			}
			w, ours := byWallet[strings.ToLower(l.To)]
			if !ours {
				// The recipient filter is server-side; this is belt and braces
				// against a provider that ignores it.
				continue
			}
			seen[id] = true
			fresh = append(fresh, store.LPPosition{
				PositionManager: npm,
				TokenID:         id,
				AgentID:         w.AgentID,
				Wallet:          w.Address,
			})
		}
		cursor = to + 1
	}
	return cursor, fresh, nil
}

// refreshOne reads one position, updates the registry, and keeps the proposed
// actions in step: a proposal stands while the recommendation that produced it
// holds, and is superseded when it stops. known distinguishes a registry row
// from a freshly discovered tokenId — a discovery that turns out not to be an
// agent-owned position is simply not registered.
func (s *Syncer) refreshOne(ctx context.Context, npm string, row store.LPPosition, known bool, byWallet map[string]store.AgentWallet, enabled map[string]bool) (outcome, bool, error) {
	tokenID, ok := new(big.Int).SetString(row.TokenID, 10)
	if !ok || tokenID.Sign() <= 0 {
		return outcomeSkipped, false, fmt.Errorf("token id %q is not a positive integer", row.TokenID)
	}
	if len(byWallet) == 0 {
		return outcomeSkipped, false, errors.New("no agent wallets to check ownership against; ownership not verified")
	}

	pos, err := s.chain.Position(ctx, npm, tokenID)
	if err != nil {
		return outcomeSkipped, false, fmt.Errorf("positions(%s): %w", tokenID, err)
	}
	// A burned token is deleted from the position manager, so positions()
	// returns its zero struct. THAT is the evidence a position is gone — not
	// an ownerOf failure, which looks identical for a burned token and for a
	// dead endpoint, and closing a live position on a provider hiccup would
	// lose it from the registry for good.
	if isZeroAddress(pos.Token0) {
		return s.closeIfKnown(ctx, npm, row.TokenID, known)
	}

	owner, err := s.chain.OwnerOf(ctx, npm, tokenID)
	if err != nil {
		return outcomeSkipped, false, fmt.Errorf("ownerOf(%s): %w", tokenID, err)
	}
	agent, ours := byWallet[strings.ToLower(owner)]
	if !ours {
		// The registry tracks what agents own. A known position that left the
		// wallet set is closed; a fresh discovery of somebody else's token is
		// simply not registered.
		return s.closeIfKnown(ctx, npm, row.TokenID, known)
	}

	pool, err := s.chain.GetPool(ctx, s.cfg.V3Factory, pos.Token0, pos.Token1, pos.Fee)
	if err != nil {
		return outcomeSkipped, false, fmt.Errorf("getPool for %s: %w", tokenID, err)
	}
	if pool == "" {
		return outcomeSkipped, false, fmt.Errorf("position %s: no pool at fee %d for %s/%s", tokenID, pos.Fee, pos.Token0, pos.Token1)
	}
	sqrtX96, currentTick, err := s.chain.Slot0(ctx, pool)
	if err != nil {
		return outcomeSkipped, false, fmt.Errorf("slot0(%s): %w", pool, err)
	}

	inRange := lp.InRange(currentTick, pos.TickLower, pos.TickUpper)
	a0, a1 := lp.PositionValue(pos.Liquidity, pos.TickLower, pos.TickUpper, sqrtX96)
	rec := lp.Recommend(inRange, pos.Liquidity)

	dec0, usd0, dec1, usd1, err := s.pairUSD(ctx, pool, pos.Token0, pos.Token1)
	if err != nil {
		return outcomeSkipped, false, err
	}

	// HARVEST: fees accrued while the position sits in range are income, and
	// realizing them should not wait for the price to leave the range. The
	// number is the EXACT accrual — the same feeGrowthInside the position
	// manager computes at collect() — and the threshold is in dollars, so the
	// loop does not propose a transaction for dust.
	//
	// An unreadable accrual is NOT treated as zero fees: the row is still
	// written with 'hold', the error is recorded, and the proposal bookkeeping
	// is skipped for this pass. Guessing here would either trigger a pointless
	// collect or supersede a harvest that was real.
	var fee0, fee1 *big.Int
	var feeUSD float64
	var feeErr error
	if rec == "hold" && pos.Liquidity.Sign() > 0 {
		f0, f1, ferr := s.exactFees(ctx, pool, pos, currentTick)
		if ferr != nil {
			feeErr = fmt.Errorf("fee accrual for %s: %w", row.TokenID, ferr)
		} else {
			fee0, fee1 = f0, f1
			feeUSD = rawToUSD(fee0, dec0, usd0) + rawToUSD(fee1, dec1, usd1)
			if feeUSD >= s.cfg.LPHarvestMinUSD {
				rec = "harvest"
			}
		}
	}

	curTick, inR := currentTick, inRange
	amt0, amt1, reco := a0.String(), a1.String(), rec
	out := store.LPPosition{
		PositionManager: npm,
		TokenID:         row.TokenID,
		AgentID:         agent.AgentID,
		Wallet:          strings.ToLower(owner),
		Pool:            pool,
		Token0:          pos.Token0,
		Token1:          pos.Token1,
		FeeTier:         int(pos.Fee),
		TickLower:       pos.TickLower,
		TickUpper:       pos.TickUpper,
		Liquidity:       pos.Liquidity.String(),
		TokensOwed0:     pos.TokensOwed0.String(),
		TokensOwed1:     pos.TokensOwed1.String(),
		CurrentTick:     &curTick,
		InRange:         &inR,
		Amount0:         &amt0,
		Amount1:         &amt1,
		Recommendation:  &reco,
	}
	if err := s.store.UpsertLPPosition(ctx, out); err != nil {
		return outcomeSkipped, false, err
	}
	if feeErr != nil {
		return outcomeSynced, false, feeErr
	}

	pending, err := s.store.PendingActions(ctx, npm, row.TokenID)
	if err != nil {
		return outcomeSynced, false, err
	}
	if rec == "hold" {
		// Back in range, or never left it: any standing proposal was made
		// under a verdict that no longer holds.
		if len(pending) > 0 {
			if err := s.store.SupersedeActions(ctx, npm, row.TokenID); err != nil {
				return outcomeSynced, false, err
			}
		}
		return outcomeSynced, false, nil
	}

	// THE OPT-IN GATE, AND WHAT IT DOES NOT BLOCK. A rebalance removes the
	// position and MINTS A NEW ONE — it is new exposure, and an agent whose
	// creator has arbitrage switched off does not get new exposure. The gate
	// runs BEFORE the "this proposal already exists" shortcut below, so a
	// rebalance queued before the switch was flipped is superseded rather than
	// left standing for the executor to pick up.
	//
	// Harvests and closes are deliberately NOT blocked: the wind-down rule in
	// migration 0069 keeps collecting fees and burning emptied positions, so
	// turning the feature off cannot strand funds in a pool.
	if !enabled[agent.AgentID] && rec == "rebalance" {
		if len(pending) > 0 {
			if err := s.store.SupersedeActions(ctx, npm, row.TokenID); err != nil {
				return outcomeSynced, false, err
			}
		}
		return outcomeSynced, false, nil
	}

	for _, a := range pending {
		if a.Recommendation == rec {
			return outcomeSynced, false, nil
		}
	}

	detail, err := s.actionDetail(ctx, rec, pool, pos, sqrtX96, currentTick, a0, a1, dec0, usd0, dec1, usd1, fee0, fee1, feeUSD)
	if err != nil {
		// The row is registered; only the proposal could not be built.
		return outcomeSynced, false, err
	}
	if err := s.store.SupersedeActions(ctx, npm, row.TokenID); err != nil {
		return outcomeSynced, false, err
	}
	if err := s.store.ProposeAction(ctx, store.LPAction{
		PositionManager: npm,
		TokenID:         row.TokenID,
		AgentID:         agent.AgentID,
		Recommendation:  rec,
		Detail:          detail,
	}); err != nil {
		return outcomeSynced, false, err
	}
	return outcomeSynced, true, nil
}

// closeIfKnown closes a registry row that is provably gone, and quietly
// ignores a fresh discovery that already reads as gone.
func (s *Syncer) closeIfKnown(ctx context.Context, npm, tokenID string, known bool) (outcome, bool, error) {
	if !known {
		return outcomeSkipped, false, nil
	}
	if err := s.store.CloseLPPosition(ctx, npm, tokenID); err != nil {
		return outcomeSkipped, false, err
	}
	if err := s.store.SupersedeActions(ctx, npm, tokenID); err != nil {
		return outcomeClosed, false, err
	}
	return outcomeClosed, false, nil
}

// actionDetail is the payload the executor carries out: for a rebalance, a
// freshly planned ±rangePct range sized for the position's current USD value;
// for a harvest, the fees and their value; for an empty position, the
// collect-and-burn.
func (s *Syncer) actionDetail(ctx context.Context, rec, pool string, pos *chain.Position, sqrtX96 *big.Int, currentTick int32, a0, a1 *big.Int, dec0 int, usd0 float64, dec1 int, usd1 float64, fee0, fee1 *big.Int, feeUSD float64) (json.RawMessage, error) {
	const note = "proposed by the loop; the executor signs it only when armed and the proposal survives its own re-checks"
	if rec == "empty" {
		return json.Marshal(map[string]any{
			"intents":      []string{"lp_collect", "lp_burn"},
			"tokens_owed0": pos.TokensOwed0.String(),
			"tokens_owed1": pos.TokensOwed1.String(),
			"note":         note,
		})
	}
	if rec == "harvest" {
		f0, f1 := "0", "0"
		if fee0 != nil {
			f0 = fee0.String()
		}
		if fee1 != nil {
			f1 = fee1.String()
		}
		return json.Marshal(map[string]any{
			"intents":    []string{"lp_collect"},
			"fees_owed0": f0,
			"fees_owed1": f1,
			"value_usd":  feeUSD,
			"note":       note,
		})
	}

	spacing, err := s.chain.TickSpacing(ctx, pool)
	if err != nil {
		return nil, fmt.Errorf("tickSpacing(%s): %w", pool, err)
	}
	valueUSD := rawToUSD(a0, dec0, usd0) + rawToUSD(a1, dec1, usd1)
	plan, err := lp.PlanFromState(lp.PoolState{
		SqrtPriceX96: sqrtX96,
		Tick:         currentTick,
		TickSpacing:  int32(spacing),
		Token0:       pos.Token0,
		Token1:       pos.Token1,
		Dec0:         dec0,
		Dec1:         dec1,
		Token0USD:    usd0,
		Token1USD:    usd1,
	}, valueUSD, s.cfg.LPRebalanceRangePct, s.cfg.LPRebalanceSlippageBps)
	if err != nil {
		return nil, fmt.Errorf("rebalance plan for %s: %w", pos.Token0+"/"+pos.Token1, err)
	}
	return json.Marshal(map[string]any{
		"intents":            []string{"lp_collect", "lp_decrease", "lp_burn", "lp_mint"},
		"position_value_usd": valueUSD,
		"current_tick":       currentTick,
		"range_pct":          s.cfg.LPRebalanceRangePct,
		"slippage_bps":       s.cfg.LPRebalanceSlippageBps,
		"plan":               plan,
		"note":               note,
	})
}

// exactFees recomputes the position's fee accrual from the pool's feeGrowth
// counters — the same numbers collect() would pay, token by token.
func (s *Syncer) exactFees(ctx context.Context, pool string, pos *chain.Position, currentTick int32) (fee0, fee1 *big.Int, err error) {
	fg0, fg1, err := s.chain.FeeGrowthGlobal(ctx, pool)
	if err != nil {
		return nil, nil, fmt.Errorf("feeGrowthGlobal(%s): %w", pool, err)
	}
	lower0, lower1, err := s.chain.TickFeeGrowthOutside(ctx, pool, pos.TickLower)
	if err != nil {
		return nil, nil, fmt.Errorf("ticks(%d): %w", pos.TickLower, err)
	}
	upper0, upper1, err := s.chain.TickFeeGrowthOutside(ctx, pool, pos.TickUpper)
	if err != nil {
		return nil, nil, fmt.Errorf("ticks(%d): %w", pos.TickUpper, err)
	}
	inside0 := lp.FeeGrowthInside(fg0, lower0, upper0, currentTick, pos.TickLower, pos.TickUpper)
	inside1 := lp.FeeGrowthInside(fg1, lower1, upper1, currentTick, pos.TickLower, pos.TickUpper)
	return lp.FeesOwed(pos.Liquidity, pos.FeeGrowthInside0LastX128, inside0, pos.TokensOwed0),
		lp.FeesOwed(pos.Liquidity, pos.FeeGrowthInside1LastX128, inside1, pos.TokensOwed1), nil
}

// pairUSD returns the decimals and USD price of each side of a pool, by the
// same rule /lp/plan uses: one side is the quote token (USDG, $1) and the
// other's price is the pool's own quote for it. Which side is token0 is read
// from the position, never assumed.
func (s *Syncer) pairUSD(ctx context.Context, pool, token0, token1 string) (dec0 int, usd0 float64, dec1 int, usd1 float64, err error) {
	usdg := s.cfg.QuoteToken
	if strings.EqualFold(token0, usdg.Address) && strings.EqualFold(token1, usdg.Address) {
		return 0, 0, 0, 0, fmt.Errorf("pool %s has the quote token on both sides", pool)
	}
	if strings.EqualFold(token0, usdg.Address) {
		stock, ok := s.tokenByAddress(token1)
		if !ok {
			return 0, 0, 0, 0, fmt.Errorf("token %s is not in the venue config", token1)
		}
		px, err := s.chain.PoolPrice(ctx, pool, stock.Address, stock.Decimals, usdg.Decimals)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("price of %s in %s: %w", token1, pool, err)
		}
		return usdg.Decimals, 1, stock.Decimals, px, nil
	}
	if !strings.EqualFold(token1, usdg.Address) {
		return 0, 0, 0, 0, fmt.Errorf("neither side of pool %s is the quote token %s", pool, usdg.Symbol)
	}
	stock, ok := s.tokenByAddress(token0)
	if !ok {
		return 0, 0, 0, 0, fmt.Errorf("token %s is not in the venue config", token0)
	}
	px, err := s.chain.PoolPrice(ctx, pool, stock.Address, stock.Decimals, usdg.Decimals)
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("price of %s in %s: %w", token0, pool, err)
	}
	return stock.Decimals, px, usdg.Decimals, 1, nil
}

func (s *Syncer) tokenByAddress(addr string) (*config.Token, bool) {
	for i := range s.cfg.Tokens {
		if strings.EqualFold(s.cfg.Tokens[i].Address, addr) {
			return &s.cfg.Tokens[i], true
		}
	}
	return nil, false
}

// rawToUSD converts a raw token amount to USD with float arithmetic, matching
// the planner's precision (the amounts stay exact in the registry; only the
// proposal sizing is a float).
func rawToUSD(amount *big.Int, decimals int, usd float64) float64 {
	if amount == nil || amount.Sign() == 0 {
		return 0
	}
	f, _ := new(big.Float).SetInt(amount).Float64()
	return f / pow10(decimals) * usd
}

func pow10(n int) float64 {
	out := 1.0
	for i := 0; i < n; i++ {
		out *= 10
	}
	return out
}

func isZeroAddress(a string) bool {
	if a == "" {
		return true
	}
	return strings.TrimPrefix(strings.ToLower(a), "0x") == strings.Repeat("0", 40)
}
