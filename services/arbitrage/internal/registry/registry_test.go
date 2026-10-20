package registry

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/config"
	"github.com/arcana/arbitrage/internal/store"
)

const (
	npmAddr  = "0x73991a25c818bf1f1128deaab1492d45638de0d3"
	factory  = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
	poolAddr = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3"
	usdgAddr = "0x5fc5360d0400a0fd4f9a3e0e1e2f0a1a2b3c4d5e"
	nvdaAddr = "0x1111111111111111111111111111111111111111"
	walletA  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	walletB  = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// --- fakes -------------------------------------------------------------------

type fakeChain struct {
	headFn      func() (int64, error)
	transfersFn func(from, to int64) ([]chain.TransferLog, error)
	positionFn  func(id *big.Int) (*chain.Position, error)
	ownerFn     func(id *big.Int) (string, error)
	poolFn      func(t0, t1 string, fee uint32) (string, error)
	slot0Fn     func(pool string) (*big.Int, int32, error)
	spacingFn   func(pool string) (int64, error)
	priceFn     func(pool, tok string) (float64, error)
	feeGrowthFn func(pool string) (g0, g1 *big.Int, err error)
	tickFeeFn   func(pool string, tick int32) (o0, o1 *big.Int, err error)
}

func (f *fakeChain) BlockNumber(context.Context) (int64, error) { return f.headFn() }
func (f *fakeChain) PositionTransfersTo(_ context.Context, _ string, _ []string, from, to int64) ([]chain.TransferLog, error) {
	return f.transfersFn(from, to)
}
func (f *fakeChain) Position(_ context.Context, _ string, id *big.Int) (*chain.Position, error) {
	return f.positionFn(id)
}
func (f *fakeChain) OwnerOf(_ context.Context, _ string, id *big.Int) (string, error) {
	return f.ownerFn(id)
}
func (f *fakeChain) GetPool(_ context.Context, _ string, t0, t1 string, fee uint32) (string, error) {
	return f.poolFn(t0, t1, fee)
}
func (f *fakeChain) Slot0(_ context.Context, pool string) (*big.Int, int32, error) {
	return f.slot0Fn(pool)
}
func (f *fakeChain) TickSpacing(_ context.Context, pool string) (int64, error) {
	return f.spacingFn(pool)
}
func (f *fakeChain) PoolPrice(_ context.Context, pool, tok string, _, _ int) (float64, error) {
	return f.priceFn(pool, tok)
}
func (f *fakeChain) FeeGrowthGlobal(_ context.Context, pool string) (*big.Int, *big.Int, error) {
	if f.feeGrowthFn != nil {
		return f.feeGrowthFn(pool)
	}
	return big.NewInt(0), big.NewInt(0), nil
}
func (f *fakeChain) TickFeeGrowthOutside(_ context.Context, pool string, tick int32) (*big.Int, *big.Int, error) {
	if f.tickFeeFn != nil {
		return f.tickFeeFn(pool, tick)
	}
	return big.NewInt(0), big.NewInt(0), nil
}

type fakeStore struct {
	wallets    []store.AgentWallet
	rows       []store.LPPosition
	actions    []store.LPAction
	upserts    []store.LPPosition
	closed     []string
	superseded []string
	proposed   []store.LPAction
	steps      []store.LPExecutionStep
	opens      []store.LPOpen

	// The opt-in: which agents the creator has switched arbitrage on for.
	enabledIDs     []string
	settingExists  bool
	settingEnabled bool
	settings       []store.AgentSetting

	beatCalled bool
	beatBlock  *int64
	beatErr    string

	// If gate is non-nil, AllAgentWallets signals entered and then waits on
	// gate — used to hold a pass open so a second one can be attempted.
	gate    chan struct{}
	entered chan struct{}
}

func (s *fakeStore) AllAgentWallets(context.Context) ([]store.AgentWallet, error) {
	if s.gate != nil {
		close(s.entered)
		<-s.gate
	}
	return s.wallets, nil
}

func (s *fakeStore) OpenLPPositions(context.Context) ([]store.LPPosition, error) {
	return s.rows, nil
}

func (s *fakeStore) UpsertLPPosition(_ context.Context, p store.LPPosition) error {
	s.upserts = append(s.upserts, p)
	for i := range s.rows {
		if s.rows[i].TokenID == p.TokenID {
			s.rows[i] = p
			return nil
		}
	}
	s.rows = append(s.rows, p)
	return nil
}

func (s *fakeStore) CloseLPPosition(_ context.Context, _, tokenID string) error {
	s.closed = append(s.closed, tokenID)
	for i := range s.rows {
		if s.rows[i].TokenID == tokenID {
			s.rows = append(s.rows[:i], s.rows[i+1:]...)
			break
		}
	}
	return nil
}

func (s *fakeStore) PendingActions(_ context.Context, _, tokenID string) ([]store.LPAction, error) {
	var out []store.LPAction
	for _, a := range s.actions {
		if a.TokenID == tokenID && a.Status == "proposed" {
			out = append(out, a)
		}
	}
	return out, nil
}

func (s *fakeStore) SupersedeActions(_ context.Context, _, tokenID string) error {
	s.superseded = append(s.superseded, tokenID)
	for i := range s.actions {
		if s.actions[i].TokenID == tokenID && s.actions[i].Status == "proposed" {
			s.actions[i].Status = "superseded"
		}
	}
	return nil
}

func (s *fakeStore) ProposeAction(_ context.Context, a store.LPAction) error {
	a.ID = int64(len(s.proposed) + 1)
	a.Status = "proposed"
	s.proposed = append(s.proposed, a)
	s.actions = append(s.actions, a)
	return nil
}

func (s *fakeStore) LPHeartbeat(_ context.Context, positions, actions int, block *int64, errMsg string) error {
	s.beatCalled = true
	s.beatBlock = block
	s.beatErr = errMsg
	return nil
}

func (s *fakeStore) DiscoveryBlock(context.Context) (int64, bool, error) {
	if s.beatBlock == nil {
		return 0, false, nil
	}
	return *s.beatBlock, true, nil
}

func (s *fakeStore) LPPositions(context.Context, string, int) ([]store.LPPosition, error) {
	return s.rows, nil
}

func (s *fakeStore) ProposedActions(context.Context, int) ([]store.LPAction, error) {
	return s.proposed, nil
}

// The public activity feeds. The fake answers with the same rows the tests put
// in, so a read path added to the Store interface cannot sit unimplemented here
// — which is what `go vet` caught on 2026-10-20, hours after the endpoints
// shipped: the production store had them, the fake did not, and the package did
// not compile until it did.
func (s *fakeStore) RecentLPExecutions(context.Context, int) ([]store.LPExecutionStep, error) {
	return s.steps, nil
}

func (s *fakeStore) RecentLPOpens(context.Context, int) ([]store.LPOpen, error) {
	return s.opens, nil
}

// --- the opt-in --------------------------------------------------------------

// THE FAKE ANSWERS WITH THE SAME DEFAULT THE DATABASE DOES: an agent that is not
// in enabledIDs is disabled, and a missing row is not an error.
func (s *fakeStore) EnabledAgentIDs(context.Context) ([]string, error) {
	return s.enabledIDs, nil
}

func (s *fakeStore) AgentSetting(_ context.Context, agentID string) (store.AgentSetting, error) {
	if !s.settingExists {
		return store.AgentSetting{AgentID: agentID}, store.ErrNoSetting
	}
	return store.AgentSetting{AgentID: agentID, Exists: true, Enabled: s.settingEnabled}, nil
}

func (s *fakeStore) SetAgentSetting(_ context.Context, agentID string, enabled bool, _ string) (store.AgentSetting, error) {
	s.settingExists, s.settingEnabled = true, enabled
	return store.AgentSetting{AgentID: agentID, Exists: true, Enabled: enabled}, nil
}

func (s *fakeStore) AllAgentSettings(context.Context, int) ([]store.AgentSetting, error) {
	return s.settings, nil
}

// --- helpers -----------------------------------------------------------------

func testCfg() *config.Config {
	return &config.Config{
		ChainID:                4663,
		V3Factory:              factory,
		PositionManager:        npmAddr,
		LPRebalanceRangePct:    0.05,
		LPRebalanceSlippageBps: 50,
		LPHarvestMinUSD:        0.5,
		QuoteToken:             config.QuoteToken{Symbol: "USDG", Address: usdgAddr, Decimals: 6},
		Tokens:                 []config.Token{{Symbol: "NVDA", Address: nvdaAddr, Decimals: 18}},
	}
}

func oneSqrt() *big.Int { return new(big.Int).Lsh(big.NewInt(1), 96) }

func position(liquidity int64) *chain.Position {
	return &chain.Position{
		Token0:                   nvdaAddr,
		Token1:                   usdgAddr,
		Fee:                      500,
		TickLower:                -1000,
		TickUpper:                1000,
		Liquidity:                big.NewInt(liquidity),
		FeeGrowthInside0LastX128: big.NewInt(0),
		FeeGrowthInside1LastX128: big.NewInt(0),
		TokensOwed0:              big.NewInt(0),
		TokensOwed1:              big.NewInt(0),
	}
}

func healthyChain(tick int32) *fakeChain {
	return &fakeChain{
		headFn: func() (int64, error) { return 1000, nil },
		transfersFn: func(_, _ int64) ([]chain.TransferLog, error) {
			return []chain.TransferLog{{Block: 900, To: walletA, TokenID: big.NewInt(7)}}, nil
		},
		positionFn: func(*big.Int) (*chain.Position, error) { return position(1_000_000_000_000_000), nil },
		ownerFn:    func(*big.Int) (string, error) { return walletA, nil },
		poolFn:     func(_, _ string, _ uint32) (string, error) { return poolAddr, nil },
		slot0Fn:    func(string) (*big.Int, int32, error) { return oneSqrt(), tick, nil },
		spacingFn:  func(string) (int64, error) { return 10, nil },
		priceFn:    func(_, _ string) (float64, error) { return 200, nil },
	}
}

func walletStore(fields ...func(*fakeStore)) *fakeStore {
	st := &fakeStore{wallets: []store.AgentWallet{{AgentID: "agent-1", Address: walletA}}}
	for _, f := range fields {
		f(st)
	}
	return st
}

func withCursor(block int64) func(*fakeStore) {
	return func(s *fakeStore) { s.beatBlock = &block }
}

func withAction(tokenID, rec string) func(*fakeStore) {
	return func(s *fakeStore) {
		s.actions = append(s.actions, store.LPAction{
			ID: 1, TokenID: tokenID, Recommendation: rec, Status: "proposed",
			Detail: json.RawMessage(`{}`),
		})
	}
}

func withOpenRow(tokenID string) func(*fakeStore) {
	return func(s *fakeStore) {
		s.rows = append(s.rows, store.LPPosition{PositionManager: npmAddr, TokenID: tokenID, AgentID: "agent-1", Wallet: walletA, Status: "open"})
	}
}

// withEnabled switches arbitrage on for the named agents. Nothing else in these
// tests enables it, which is the point: the default is off.
func withEnabled(agentIDs ...string) func(*fakeStore) {
	return func(s *fakeStore) { s.enabledIDs = agentIDs }
}

// --- tests -------------------------------------------------------------------

func TestSyncDiscoversAndProposesRebalance(t *testing.T) {
	ch := healthyChain(5000) // above the position's [-1000, 1000) range
	// THE CREATOR HAS SWITCHED IT ON. Proposing a rebalance is now gated on the
	// opt-in, so a test that asserts "discovery leads to a proposal" has to say
	// so — TestDisabledAgentGetsNoRebalanceProposal is the same setup with the
	// switch off, and it asserts the opposite.
	st := walletStore(withCursor(1), withEnabled("agent-1"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Discovered != 1 || res.Synced != 1 || res.Proposed != 1 || res.Errors != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(st.upserts) != 1 || st.upserts[0].TokenID != "7" {
		t.Fatalf("expected one upsert for token 7, got %+v", st.upserts)
	}
	if st.upserts[0].Recommendation == nil || *st.upserts[0].Recommendation != "rebalance" {
		t.Fatalf("expected recommendation rebalance, got %+v", st.upserts[0].Recommendation)
	}
	if len(st.proposed) != 1 || st.proposed[0].Recommendation != "rebalance" {
		t.Fatalf("expected one rebalance proposal, got %+v", st.proposed)
	}
	if !strings.Contains(string(st.proposed[0].Detail), "lp_mint") {
		t.Fatalf("proposal should name the lp_mint intent, got %s", st.proposed[0].Detail)
	}
	if !st.beatCalled || st.beatBlock == nil || *st.beatBlock != 1001 {
		t.Fatalf("expected heartbeat with cursor 1001, got %v", st.beatBlock)
	}
}

func TestSyncProposesHarvestWhenFeesCrossTheThreshold(t *testing.T) {
	ch := healthyChain(0) // in range
	q128sum := new(big.Int).Lsh(big.NewInt(1), 128)
	// 1000 units of token0 growth on 1e15 liquidity = 1e18 raw token0 = 1 NVDA
	// at the fake $200 price — $200 accrued, far over the $0.50 threshold.
	ch.feeGrowthFn = func(string) (*big.Int, *big.Int, error) {
		return new(big.Int).Mul(big.NewInt(1000), q128sum), big.NewInt(0), nil
	}
	st := walletStore(withCursor(1), withOpenRow("7"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 1 || res.Errors != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(st.upserts) != 1 || st.upserts[0].Recommendation == nil || *st.upserts[0].Recommendation != "harvest" {
		t.Fatalf("the registry row should say harvest, got %+v", st.upserts)
	}
	if len(st.proposed) != 1 || st.proposed[0].Recommendation != "harvest" {
		t.Fatalf("expected one harvest proposal, got %+v", st.proposed)
	}
	if !strings.Contains(string(st.proposed[0].Detail), `"intents":["lp_collect"]`) {
		t.Fatalf("a harvest is one collect, got %s", st.proposed[0].Detail)
	}
	if !strings.Contains(string(st.proposed[0].Detail), "1000000000000000000") {
		t.Fatalf("the proposal should carry the exact accrual, got %s", st.proposed[0].Detail)
	}
}

func TestSyncKeepsHoldWhenFeesAreBelowTheThreshold(t *testing.T) {
	ch := healthyChain(0)
	q128sum := new(big.Int).Lsh(big.NewInt(1), 128)
	// 2 units on 1e15 liquidity = 2e15 raw = 0.002 NVDA = $0.40, under $0.50.
	ch.feeGrowthFn = func(string) (*big.Int, *big.Int, error) {
		return new(big.Int).Mul(big.NewInt(2), q128sum), big.NewInt(0), nil
	}
	st := walletStore(withCursor(1), withOpenRow("7"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 0 {
		t.Fatalf("under the threshold there is nothing to propose: %+v", res)
	}
	if st.upserts[0].Recommendation == nil || *st.upserts[0].Recommendation != "hold" {
		t.Fatalf("expected hold, got %+v", st.upserts[0].Recommendation)
	}
}

// An unreadable accrual is not zero fees: the row keeps 'hold', the error is
// recorded, and a standing proposal is left alone — guessing here would either
// fire a pointless collect or supersede a harvest that was real.
func TestSyncLeavesProposalsAloneWhenFeeAccrualIsUnreadable(t *testing.T) {
	ch := healthyChain(0)
	ch.feeGrowthFn = func(string) (*big.Int, *big.Int, error) {
		return nil, nil, errors.New("fee growth unreadable")
	}
	st := walletStore(withCursor(1), withOpenRow("7"), withAction("7", "harvest"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Errors != 1 {
		t.Fatalf("the unreadable accrual must be recorded: %+v", res)
	}
	if len(st.superseded) != 0 || len(st.proposed) != 0 {
		t.Fatalf("proposals must be left alone, superseded=%v proposed=%v", st.superseded, st.proposed)
	}
	if st.upserts[0].Recommendation == nil || *st.upserts[0].Recommendation != "hold" {
		t.Fatalf("expected hold, got %+v", st.upserts[0].Recommendation)
	}
}

func TestSyncSupersedesProposalWhenBackInRange(t *testing.T) {
	ch := healthyChain(0) // inside [-1000, 1000)
	st := walletStore(withCursor(1001), withOpenRow("7"), withAction("7", "rebalance"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 0 || res.Synced != 1 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(st.superseded) != 1 || st.superseded[0] != "7" {
		t.Fatalf("expected the standing proposal to be superseded, got %v", st.superseded)
	}
	if len(st.proposed) != 0 {
		t.Fatalf("no new proposal expected while in range, got %+v", st.proposed)
	}
}

func TestSyncKeepsProposalWhileItStillHolds(t *testing.T) {
	// THE AGENT IS ENABLED, AND THAT IS NOW PART OF THE SETUP. A standing
	// rebalance belongs to an agent whose creator has arbitrage switched on;
	// with the switch off, the same proposal is superseded on purpose
	// (TestDisabledAgentSupersedesAStandingRebalance covers that direction).
	ch := healthyChain(5000)
	st := walletStore(withCursor(1001), withOpenRow("7"), withAction("7", "rebalance"), withEnabled("agent-1"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 0 || len(st.proposed) != 0 || len(st.superseded) != 0 {
		t.Fatalf("proposal should stand untouched, got result %+v superseded %v proposed %v", res, st.superseded, st.proposed)
	}
}

func TestSyncClosesBurnedPosition(t *testing.T) {
	ch := healthyChain(0)
	ch.positionFn = func(*big.Int) (*chain.Position, error) {
		return &chain.Position{Token0: "0x0000000000000000000000000000000000000000"}, nil
	}
	st := walletStore(withCursor(1001), withOpenRow("7"), withAction("7", "rebalance"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Closed != 1 || res.Synced != 0 {
		t.Fatalf("expected one closure, got %+v", res)
	}
	if len(st.closed) != 1 || st.closed[0] != "7" {
		t.Fatalf("expected token 7 closed, got %v", st.closed)
	}
	if len(st.superseded) != 1 {
		t.Fatalf("a closed position's proposal must be retired, got %v", st.superseded)
	}
}

// An unreadable ownerOf must NOT close anything: it looks identical for a
// burned token and for a dead endpoint, and a wrong closure loses the
// position from the registry for good.
func TestSyncKeepsPositionOnOwnerReadFailure(t *testing.T) {
	ch := healthyChain(0)
	ch.ownerFn = func(*big.Int) (string, error) { return "", errors.New("rpc exploded") }
	st := walletStore(withCursor(1001), withOpenRow("7"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Errors != 1 || res.Closed != 0 || len(st.closed) != 0 {
		t.Fatalf("read failure must not close: result %+v closed %v", res, st.closed)
	}
	if len(st.upserts) != 0 {
		t.Fatalf("nothing should be written when ownership cannot be verified, got %+v", st.upserts)
	}
}

func TestSyncIgnoresFreshTokenOwnedByStranger(t *testing.T) {
	ch := healthyChain(0)
	ch.ownerFn = func(*big.Int) (string, error) { return walletB, nil }
	st := walletStore(withCursor(1)) // no registered rows; walletB not in the wallet set
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Discovered != 1 || res.Synced != 0 || res.Skipped != 1 || res.Closed != 0 {
		t.Fatalf("a stranger's token must be skipped, not synced: %+v", res)
	}
	if len(st.upserts) != 0 || len(st.closed) != 0 {
		t.Fatalf("expected no writes, got upserts %+v closed %v", st.upserts, st.closed)
	}
}

func TestDiscoveryCursorStopsAtFailedWindow(t *testing.T) {
	ch := healthyChain(0)
	ch.headFn = func() (int64, error) { return 250_000, nil }
	ch.transfersFn = func(from, _ int64) ([]chain.TransferLog, error) {
		if from > discoveryWindowBlocks {
			return nil, errors.New("provider said no")
		}
		return nil, nil
	}
	st := walletStore(withCursor(1))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Errors != 1 {
		t.Fatalf("expected the failed window to be reported: %+v", res)
	}
	// The cursor stops at the first block of the failed window, so the next
	// pass re-reads it instead of moving past it.
	if st.beatBlock == nil || *st.beatBlock != discoveryWindowBlocks+1 {
		t.Fatalf("expected cursor %d, got %v", discoveryWindowBlocks+1, st.beatBlock)
	}
}

func TestSyncRefusesSecondConcurrentPass(t *testing.T) {
	st := walletStore()
	st.gate = make(chan struct{})
	st.entered = make(chan struct{})
	sy := New(healthyChain(0), st, testCfg())

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = sy.SyncOnce(context.Background())
	}()
	<-st.entered

	if _, err := sy.SyncOnce(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy from a concurrent pass, got %v", err)
	}
	close(st.gate)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("first pass did not finish")
	}
}

// --- the opt-in gate ---------------------------------------------------------

// THE DEFAULT IS OFF, AND OFF MEANS NO NEW EXPOSURE. An out-of-range position
// of a disabled agent is still refreshed — the record stays truthful — but the
// rebalance that would mint a new position is not proposed.
func TestDisabledAgentGetsNoRebalanceProposal(t *testing.T) {
	st := walletStore(withCursor(1))
	sy := New(healthyChain(5000), st, testCfg()) // price above the range

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Synced != 1 || res.Errors != 0 {
		t.Fatalf("the position should still be refreshed: %+v", res)
	}
	if res.Enabled != 0 {
		t.Fatalf("nothing is enabled in this test, got %d", res.Enabled)
	}
	if len(st.proposed) != 0 {
		t.Fatalf("a disabled agent was proposed for: %+v", st.proposed)
	}
	// The row itself still says rebalance: the registry reports the truth about
	// the chain, and the gate decides what may be DONE about it.
	if len(st.upserts) != 1 || st.upserts[0].Recommendation == nil || *st.upserts[0].Recommendation != "rebalance" {
		t.Fatalf("the registry row should still read rebalance, got %+v", st.upserts)
	}
}

// A REBALANCE QUEUED BEFORE THE SWITCH WAS FLIPPED IS SUPERSEDED, so the
// executor cannot pick up a decision its owner has already revoked.
func TestDisabledAgentSupersedesAStandingRebalance(t *testing.T) {
	st := walletStore(withCursor(1001), withOpenRow("7"), withAction("7", "rebalance"))
	sy := New(healthyChain(5000), st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 0 || len(st.proposed) != 0 {
		t.Fatalf("expected no proposal, got %+v", st.proposed)
	}
	if len(st.superseded) == 0 {
		t.Fatal("the standing rebalance should have been superseded")
	}
}

// THE WIND-DOWN RULE: switching arbitrage off must not strand fees. A harvest
// is income, not new exposure, so a disabled agent still gets it.
func TestDisabledAgentStillGetsHarvest(t *testing.T) {
	ch := healthyChain(0) // in range
	q128sum := new(big.Int).Lsh(big.NewInt(1), 128)
	ch.feeGrowthFn = func(string) (*big.Int, *big.Int, error) {
		return new(big.Int).Mul(big.NewInt(1000), q128sum), big.NewInt(0), nil
	}
	st := walletStore(withCursor(1), withOpenRow("7"))
	sy := New(ch, st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Proposed != 1 || len(st.proposed) != 1 || st.proposed[0].Recommendation != "harvest" {
		t.Fatalf("a disabled agent should still be able to harvest its fees: %+v", st.proposed)
	}
}

// AND THE GATE DOES NOT OVER-BLOCK: an enabled agent gets exactly what it got
// before the switch existed.
func TestEnabledAgentGetsTheRebalance(t *testing.T) {
	st := walletStore(withCursor(1), withEnabled("agent-1"))
	sy := New(healthyChain(5000), st, testCfg())

	res, err := sy.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if res.Enabled != 1 {
		t.Fatalf("expected one enabled agent, got %d", res.Enabled)
	}
	if len(st.proposed) != 1 || st.proposed[0].Recommendation != "rebalance" {
		t.Fatalf("an enabled agent should still be proposed for: %+v", st.proposed)
	}
}
