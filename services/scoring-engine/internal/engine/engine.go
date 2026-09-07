package engine

import (
	"context"
	"log"
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
// Idempotent and resumable: each agent is checkpointed by its own snapshot row.
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

// Leaderboard returns the latest score per agent sorted by a category column.
func (e *Engine) Leaderboard(ctx context.Context, category string, page, pageSize int) ([]store.LeaderboardEntry, error) {
	return e.store.Leaderboard(ctx, category, pageSize, (page-1)*pageSize)
}

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
	for _, p := range points {
		navs = append(navs, mustParse(p.NAV))
	}
	creatorRep := mustParse(meta.CreatorRepScore)

	f := ComputeFactors(navs, meta.AgeDays, creatorRep, decisions)
	ts := time.Now().UTC().Truncate(time.Second)

	return e.store.WriteScoreSnapshot(ctx, ap.AgentID, ts, f.toMap())
}
