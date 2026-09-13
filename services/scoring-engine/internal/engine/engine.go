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
// seasonID scopes it to one season ("" = whichever season scored most recently).
func (e *Engine) LatestScore(ctx context.Context, agentID, seasonID string) (*store.ScoreRow, error) {
	return e.store.LatestScore(ctx, agentID, seasonID)
}

// ScoreHistory returns the agent's score series (see store.ScoreHistory).
// seasonID scopes the series to one season ("" = every season).
func (e *Engine) ScoreHistory(ctx context.Context, agentID, seasonID string, from, to *time.Time, daily bool) ([]store.ScoreHistoryPoint, error) {
	return e.store.ScoreHistory(ctx, agentID, seasonID, from, to, daily)
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

// scoreAgent loads one agent's inputs, computes factors, and appends a SEALED
// row whose manifest names the formula, the constants, every input and every
// output — so the number can be computed again by anyone, not only trusted.
//
// The inputs are gathered into ScoreInputs first and the context is derived
// from them by ContextFromInputs, the same function a recomputation from the
// manifest uses. What the batch computed and what a checker computes therefore
// come from one derivation, not two that happen to agree.
func (e *Engine) scoreAgent(ctx context.Context, ap store.AgentPortfolio) error {
	points, err := e.store.PortfolioNAVSeries(ctx, ap.PortfolioID)
	if err != nil {
		return err
	}
	meta, err := e.store.LoadAgentMeta(ctx, ap.AgentID)
	if err != nil {
		return err
	}
	// The decisions counted: the same rows DecisionCount and DecisionMixFor
	// count (decisions_counted, this season), listed so each can be checked.
	decisions, err := e.store.DecisionsFor(ctx, ap.AgentID, ap.SeasonID)
	if err != nil {
		return err
	}
	// creator_score: the performance scores the creator factor averages, in the
	// order it averages them.
	peers, err := e.store.CreatorPeerScores(ctx, meta.CreatorID, ap.AgentID)
	if err != nil {
		return err
	}

	in := ScoreInputs{StrategyType: meta.StrategyType}
	for _, p := range points {
		in.NAVSeries = append(in.NAVSeries, NAVPoint{TS: p.TS, NAV: p.NAV, Cash: p.Cash, Seal: p.Seal})
	}
	for _, d := range decisions {
		in.Decisions = append(in.Decisions, DecisionRef{ID: d.ID, TS: d.TS, Action: d.Action, Commitment: d.Commitment})
	}
	for _, p := range peers {
		in.CreatorPeers = append(in.CreatorPeers, PeerScore{
			AgentID: p.AgentID, SeasonID: p.SeasonID, TS: p.TS, Performance: p.Performance, Seal: p.Seal,
		})
	}

	f := ComputeFactors(ContextFromInputs(in))
	ts := time.Now().UTC().Truncate(time.Second)

	seals := InputSeals(in)
	inputs := make([]store.InputSeal, 0, len(seals))
	for _, s := range seals {
		inputs = append(inputs, store.InputSeal{Kind: s[0], Seal: s[1]})
	}
	_, err = e.store.WriteScoreSnapshotSealed(ctx, ap.AgentID, ap.SeasonID, ts, f.toMap(),
		func(previousSeal string) string {
			return BuildScoreManifest(ap.AgentID, ap.SeasonID, ts, in, f, previousSeal)
		}, inputs)
	if err == nil {
		return nil
	}
	// A SCORE IS NEVER LOST TO ITS SEAL — the rule decisions and snapshots
	// follow. The row is written the way it was before seals existed and the
	// missing seal is logged as an error; the public record then shows an
	// unsealed score, which is true.
	log.Printf("ERROR score for agent %s in season %s could not be sealed; recording it without a seal: %v",
		ap.AgentID, ap.SeasonID, err)
	return e.store.WriteScoreSnapshot(ctx, ap.AgentID, ap.SeasonID, ts, f.toMap())
}

// mustParse converts a NUMERIC string to float64, ignoring parse errors (0).
func mustParse(s string) float64 {
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v
	}
	return 0
}
