package store

import (
	"context"
	"encoding/json"
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

// AgentRow is the minimal agent projection the engine needs.
type AgentRow struct {
	ID            string
	Status        string
	RiskProfile   map[string]any
	AssetUniverse string
}

// GetActiveAgent loads an agent and verifies it is active.
func (s *Store) GetActiveAgent(ctx context.Context, agentID string) (*AgentRow, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, status, risk_profile, asset_universe FROM agents WHERE id = $1`, agentID)
	var a AgentRow
	var risk []byte
	if err := row.Scan(&a.ID, &a.Status, &risk, &a.AssetUniverse); err != nil {
		return nil, fmt.Errorf("load agent %s: %w", agentID, err)
	}
	if err := json.Unmarshal(risk, &a.RiskProfile); err != nil {
		return nil, fmt.Errorf("parse risk_profile: %w", err)
	}
	if a.Status != "active" {
		return nil, fmt.Errorf("agent %s is not active (status=%s)", agentID, a.Status)
	}
	return &a, nil
}

// SeasonRuleset returns the season ruleset JSON (for initial capital etc).
func (s *Store) GetSeasonRuleset(ctx context.Context, seasonID string) (map[string]any, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT ruleset FROM seasons WHERE id = $1`, seasonID).Scan(&raw)
	if err != nil {
		return nil, fmt.Errorf("load season %s: %w", seasonID, err)
	}
	var ruleset map[string]any
	if err := json.Unmarshal(raw, &ruleset); err != nil {
		return nil, fmt.Errorf("parse season ruleset: %w", err)
	}
	return ruleset, nil
}

// PortfolioRow is a portfolio with its latest snapshot values.
type PortfolioRow struct {
	ID       string
	Cash     string
	NAV      string
	Holdings map[string]any // symbol -> quantity
}

// GetOrCreatePortfolio finds the portfolio for (agent, season) or creates it
// with the season's initial capital. On an existing portfolio the latest
// snapshot's holdings/cash/nav are loaded as the starting state.
func (s *Store) GetOrCreatePortfolio(ctx context.Context, agentID, seasonID string, initialCapital string) (*PortfolioRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var id string
	err = tx.QueryRow(ctx,
		`SELECT id FROM portfolios WHERE agent_id = $1 AND season_id = $2`, agentID, seasonID).Scan(&id)
	if err == nil {
		// Load latest snapshot if present.
		p := &PortfolioRow{ID: id, Holdings: map[string]any{}}
		var holdings []byte
		err = tx.QueryRow(ctx,
			`SELECT cash, nav, holdings FROM portfolio_snapshots
			 WHERE portfolio_id = $1 ORDER BY ts DESC LIMIT 1`,
			id).Scan(&p.Cash, &p.NAV, &holdings)
		if err == pgx.ErrNoRows {
			p.Cash = initialCapital
			p.NAV = initialCapital
		} else if err != nil {
			return nil, fmt.Errorf("load latest snapshot: %w", err)
		} else {
			if err := json.Unmarshal(holdings, &p.Holdings); err != nil {
				return nil, fmt.Errorf("parse holdings: %w", err)
			}
		}
		return p, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("query portfolio: %w", err)
	}

	// Create new portfolio.
	err = tx.QueryRow(ctx,
		`INSERT INTO portfolios (agent_id, season_id, initial_capital)
		 VALUES ($1, $2, $3) RETURNING id`,
		agentID, seasonID, initialCapital).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create portfolio: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &PortfolioRow{ID: id, Cash: initialCapital, NAV: initialCapital, Holdings: map[string]any{}}, nil
}

// AppendDecision inserts an immutable decision row. Returns the new id.
func (s *Store) AppendDecision(ctx context.Context, d DecisionInsert) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`INSERT INTO decisions
		   (agent_id, season_id, ts, market_snapshot_ref, action, symbol, quantity, resulting_allocation, rationale)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id`,
		d.AgentID, d.SeasonID, d.TS, d.MarketSnapshotRef, d.Action, d.Symbol, d.Quantity,
		d.ResultingAllocation, d.Rationale,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("append decision: %w", err)
	}
	return id, nil
}

// WriteSnapshot upserts a portfolio snapshot for a point in time.
func (s *Store) WriteSnapshot(ctx context.Context, portfolioID string, ts time.Time, holdings map[string]any, nav, cash string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO portfolio_snapshots (portfolio_id, ts, holdings, nav, cash)
		 VALUES ($1, $2, $3, $4, $5)`,
		portfolioID, ts, holdings, nav, cash)
	if err != nil {
		return fmt.Errorf("write portfolio snapshot: %w", err)
	}
	return nil
}

// DecisionInsert is the storage shape of an append-only decision.
type DecisionInsert struct {
	AgentID             string
	SeasonID            string
	TS                  time.Time
	MarketSnapshotRef   string
	Action              string
	Symbol              string
	Quantity            *string
	ResultingAllocation map[string]any
	Rationale           string
}
