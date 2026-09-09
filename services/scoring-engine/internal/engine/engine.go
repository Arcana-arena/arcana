package engine

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/arcana/scoring-engine/internal/store"
)

// Engine runs the ARCANA Score batch.
type Engine struct {
	store *store.Store
}

func New(st *store.Store) *Engine {
	return &Engine{store: st}
}

// BatchResult summarizes a batch run.
type BatchResult struct {
	Processed int `json:"processed"`
	Skipped   int `json:"skipped"`
}

// RunBatch recomputes scores for every active agent that has a portfolio.
// Idempotent: each run appends a NEW snapshot row (append-only per §12), it
// never mutates previous rows. Safe to run repeatedly.
func (e *Engine) RunBatch(ctx context.Context) (*BatchResult, error) {
	agents, err := e.store.ActiveScorableAgents(ctx)
	if err != nil {
		return nil, err
	}

	res := &BatchResult{}
	for _, ap := range agents {
		if err := e.scoreAgent(ctx, ap); err != nil {
			log.Printf("score agent %s: %v", ap.AgentID, err)
			res.Skipped++
			continue
		}
		res.Processed++
	}
	return res, nil
}

// ScoreAgent computes and persists a score snapshot for one agent+season.
func (e *Engine) ScoreAgent(ctx context.Context, agentID, seasonID string) error {
	ap, err := e.store.PortfolioForAgent(ctx, agentID, seasonID)
	if err != nil {
		return err
	}
	return e.scoreAgent(ctx, *ap)
}

// LatestScore returns the most recent score snapshot for an agent.
func (e *Engine) LatestScore(ctx context.Context, agentID string) (*store.ScoreRow, error) {
	return e.store.LatestScore(ctx, agentID)
}

// ScoreHistory returns the agent's score series (see store.ScoreHistory).
func (e *Engine) ScoreHistory(ctx context.Context, agentID string, from, to *time.Time, daily bool) ([]store.ScoreHistoryPoint, error) {
	return e.store.ScoreHistory(ctx, agentID, from, to, daily)
}

// Leaderboard returns the latest score per agent sorted by a category column.
// seasonID filters to agents with a portfolio in that season ("" = all).
func (e *Engine) Leaderboard(ctx context.Context, category, seasonID string, page, pageSize int) ([]store.LeaderboardEntry, error) {
	return e.store.Leaderboard(ctx, category, seasonID, pageSize, (page-1)*pageSize)
}

// Season returns the arena a leaderboard page is filtered to, or nil when the
// id names no season. Identity and access tier only -- see store.SeasonRow on
// why reading a tier here does not cross the §2.7 scoring boundary.
func (e *Engine) Season(ctx context.Context, seasonID string) (*store.SeasonRow, error) {
	return e.store.Season(ctx, seasonID)
}

// scoreAgent loads one agent's full context, computes factors, appends a row.
func (e *Engine) scoreAgent(ctx context.Context, ap store.AgentPortfolio) error {
	points, err := e.store.PortfolioNAVSeries(ctx, ap.PortfolioID)
	if err != nil {
		return err
	}
	meta, err := e.store.LoadAgentMeta(ctx, ap.AgentID)
	if err != nil {
		return err
	}
	decisions, err := e.store.DecisionCount(ctx, ap.AgentID, ap.SeasonID)
	if err != nil {
		return err
	}

	navs := make([]float64, 0, len(points))
	// Mean fraction of the book actually held in positions. Ticks with a
	// non-positive NAV are skipped rather than counted as zero exposure, which
	// would quietly drag the average down on bad data.
	exposureSum, exposureTicks := 0.0, 0
	for _, p := range points {
		nav := mustParse(p.NAV)
		navs = append(navs, nav)
		if nav > 0 {
			invested := (nav - mustParse(p.Cash)) / nav
			if invested < 0 {
				invested = 0
			}
			exposureSum += invested
			exposureTicks++
		}
	}
	exposure := 0.0
	if exposureTicks > 0 {
		exposure = exposureSum / float64(exposureTicks)
	}

	// creator_score: mean of the creator's other scored agents' performance.
	var peerMean *float64
	peers, err := e.store.CreatorPeerScores(ctx, meta.CreatorID, ap.AgentID)
	if err != nil {
		return err
	}
	if len(peers) > 0 {
		sum := 0.0
		for _, v := range peers {
			sum += v
		}
		m := sum / float64(len(peers))
		peerMean = &m
	}

	// strategy_score needs the action mix, not just the decision count.
	mix, err := e.store.DecisionMixFor(ctx, ap.AgentID, ap.SeasonID)
	if err != nil {
		return err
	}

	f := ComputeFactors(AgentContext{
		NAVs:                   navs,
		DecisionCount:          decisions,
		Exposure:               exposure,
		StrategyType:           meta.StrategyType,
		Buys:                   mix.Buys,
		Sells:                  mix.Sells,
		CreatorPeerPerformance: peerMean,
	})
	ts := time.Now().UTC().Truncate(time.Second)

	return e.store.WriteScoreSnapshot(ctx, ap.AgentID, ts, f.toMap())
}

// mustParse converts a NUMERIC string to float64, ignoring parse errors (0).
func mustParse(s string) float64 {
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v
	}
	return 0
}
