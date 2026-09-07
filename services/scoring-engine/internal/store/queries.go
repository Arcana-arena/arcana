package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// AgentPortfolio couples an agent with its portfolio in a season.
type AgentPortfolio struct {
	AgentID     string
	SeasonID    string
	PortfolioID string
}

// ActiveScorableAgents lists agents that have a portfolio (and thus decisions/snapshots).
func (s *Store) ActiveScorableAgents(ctx context.Context) ([]AgentPortfolio, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id, p.season_id, p.id
		FROM agents a
		JOIN portfolios p ON p.agent_id = a.id
		WHERE a.status = 'active'
		ORDER BY a.id`)
	if err != nil {
		return nil, fmt.Errorf("list scorable agents: %w", err)
	}
	defer rows.Close()

	var out []AgentPortfolio
	for rows.Next() {
		var ap AgentPortfolio
		if err := rows.Scan(&ap.AgentID, &ap.SeasonID, &ap.PortfolioID); err != nil {
			return nil, err
		}
		out = append(out, ap)
	}
	return out, rows.Err()
}

// PortfolioForAgent returns the agent's portfolio in a given season, if any.
func (s *Store) PortfolioForAgent(ctx context.Context, agentID, seasonID string) (*AgentPortfolio, error) {
	var ap AgentPortfolio
	err := s.pool.QueryRow(ctx, `
		SELECT p.agent_id, p.season_id, p.id
		FROM portfolios p
		WHERE p.agent_id = $1 AND p.season_id = $2`,
		agentID, seasonID).Scan(&ap.AgentID, &ap.SeasonID, &ap.PortfolioID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("no portfolio for agent %s in season %s", agentID, seasonID)
		}
		return nil, fmt.Errorf("load portfolio for agent %s: %w", agentID, err)
	}
	return &ap, nil
}

// SnapshotPoint is one NAV observation for a portfolio.
type SnapshotPoint struct {
	TS  time.Time
	NAV string
}

// PortfolioNAVSeries returns all NAV snapshots for a portfolio ordered by time.
func (s *Store) PortfolioNAVSeries(ctx context.Context, portfolioID string) ([]SnapshotPoint, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ts, nav FROM portfolio_snapshots
		WHERE portfolio_id = $1
		ORDER BY ts ASC`, portfolioID)
	if err != nil {
		return nil, fmt.Errorf("load nav series %s: %w", portfolioID, err)
	}
	defer rows.Close()

	var out []SnapshotPoint
	for rows.Next() {
		var p SnapshotPoint
		if err := rows.Scan(&p.TS, &p.NAV); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AgentLongevityDays returns the agent age in days (from created_at) and its
// creator reputation.
type AgentMeta struct {
	AgeDays         float64
	CreatorRepScore string
}

// LoadAgentMeta reads agent age and linked creator reputation.
func (s *Store) LoadAgentMeta(ctx context.Context, agentID string) (*AgentMeta, error) {
	var m AgentMeta
	err := s.pool.QueryRow(ctx, `
		SELECT EXTRACT(EPOCH FROM (now() - a.created_at)) / 86400.0,
		       COALESCE(c.reputation_score, 0)
		FROM agents a
		LEFT JOIN creators c ON c.id = a.creator_id
		WHERE a.id = $1`, agentID).Scan(&m.AgeDays, &m.CreatorRepScore)
	if err != nil {
		return nil, fmt.Errorf("load agent meta %s: %w", agentID, err)
	}
	return &m, nil
}

// DecisionCount returns number of recorded decisions for an agent in a season.
func (s *Store) DecisionCount(ctx context.Context, agentID, seasonID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM decisions
		WHERE agent_id = $1 AND season_id = $2`, agentID, seasonID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count decisions: %w", err)
	}
	return n, nil
}

// WriteScoreSnapshot inserts a score row (idempotent per agent/timestamp).
func (s *Store) WriteScoreSnapshot(ctx context.Context, agentID string, ts time.Time, factors map[string]*float64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO score_snapshots (
			agent_id, ts, arcana_score,
			performance_score, risk_score, strategy_score, regime_score,
			consistency_score, creator_score, longevity_score
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (agent_id, ts) DO NOTHING`,
		agentID, ts,
		factors["arcana"], factors["performance"], factors["risk"],
		factors["strategy"], factors["regime"], factors["consistency"],
		factors["creator"], factors["longevity"])
	if err != nil {
		return fmt.Errorf("write score snapshot for %s: %w", agentID, err)
	}
	return nil
}

// ScoreRow is one persisted score snapshot.
type ScoreRow struct {
	AgentID         string     `json:"agent_id"`
	TS              time.Time  `json:"ts"`
	ArcanaScore     *float64   `json:"arcana_score"`
	PerformanceScore *float64  `json:"performance_score"`
	RiskScore       *float64   `json:"risk_score"`
	StrategyScore   *float64   `json:"strategy_score"`
	RegimeScore     *float64   `json:"regime_score"`
	ConsistencyScore *float64  `json:"consistency_score"`
	CreatorScore    *float64   `json:"creator_score"`
	LongevityScore  *float64   `json:"longevity_score"`
}

// LatestScore returns the newest score snapshot for an agent.
// Note: score_snapshots has no season column; per-season filtering is not
// supported yet (an agent's latest score covers its most recent season run).
func (s *Store) LatestScore(ctx context.Context, agentID string) (*ScoreRow, error) {
	q := `
		SELECT agent_id, ts, arcana_score, performance_score, risk_score,
		       strategy_score, regime_score, consistency_score, creator_score, longevity_score
		FROM score_snapshots
		WHERE agent_id = $1
		ORDER BY ts DESC LIMIT 1`

	var srow ScoreRow
	err := s.pool.QueryRow(ctx, q, agentID).Scan(
		&srow.AgentID, &srow.TS, &srow.ArcanaScore, &srow.PerformanceScore,
		&srow.RiskScore, &srow.StrategyScore, &srow.RegimeScore,
		&srow.ConsistencyScore, &srow.CreatorScore, &srow.LongevityScore,
	)
	if err != nil {
		return nil, fmt.Errorf("latest score for agent %s: %w", agentID, err)
	}
	return &srow, nil
}

// LeaderboardEntry is one agent row on the leaderboard (its latest score).
type LeaderboardEntry struct {
	Rank            int        `json:"rank"`
	AgentID         string     `json:"agent_id"`
	AgentName       string     `json:"agent_name"`
	ArcanaScore     *float64   `json:"arcana_score"`
	PerformanceScore *float64  `json:"performance_score"`
	RiskScore       *float64   `json:"risk_score"`
	ConsistencyScore *float64  `json:"consistency_score"`
	LongevityScore  *float64   `json:"longevity_score"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// LeaderboardSortColumn maps a leaderboard category to a score column.
// Only columns present in score_snapshots are supported.
var LeaderboardSortColumn = map[string]string{
	"arcana":      "arcana_score",
	"performance": "performance_score",
	"consistency": "consistency_score",
	"risk":        "risk_score",
	"longevity":   "longevity_score",
}

// Leaderboard returns the latest score per agent, sorted by the given column.
func (s *Store) Leaderboard(ctx context.Context, sortColumn string, limit, offset int) ([]LeaderboardEntry, error) {
	// Validate sort column against allow-list to avoid SQL injection.
	if _, ok := LeaderboardSortColumn[sortColumn]; !ok {
		return nil, fmt.Errorf("unsupported leaderboard category: %s", sortColumn)
	}
	col := LeaderboardSortColumn[sortColumn]

	q := fmt.Sprintf(`
		WITH latest AS (
			SELECT DISTINCT ON (agent_id) agent_id, ts,
			       arcana_score, performance_score, risk_score,
			       consistency_score, longevity_score
			FROM score_snapshots
			ORDER BY agent_id, ts DESC
		)
		SELECT l.agent_id, COALESCE(a.name, ''), l.arcana_score,
		       l.performance_score, l.risk_score, l.consistency_score,
		       l.longevity_score, l.ts
		FROM latest l
		LEFT JOIN agents a ON a.id = l.agent_id
		WHERE l.%s IS NOT NULL
		ORDER BY l.%s DESC
		LIMIT $1 OFFSET $2`, col, col)

	rows, err := s.pool.Query(ctx, q, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("leaderboard query: %w", err)
	}
	defer rows.Close()

	var out []LeaderboardEntry
	for rows.Next() {
		var e LeaderboardEntry
		if err := rows.Scan(&e.AgentID, &e.AgentName, &e.ArcanaScore,
			&e.PerformanceScore, &e.RiskScore, &e.ConsistencyScore,
			&e.LongevityScore, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Rank = offset + i + 1
	}
	return out, nil
}
